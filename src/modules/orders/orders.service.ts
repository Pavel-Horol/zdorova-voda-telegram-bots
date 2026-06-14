import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from '../clients/clients.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import {
  ORDER_DISPATCHER,
  type OrderDispatcher,
} from '../../bots/shared/order-dispatcher';
import {
  ORDER_STATUS_CHANGED,
  type OrderStatusChangedEvent,
} from './order-events';
import { OrderStatus } from '../../../generated/prisma/enums';
import type { Order, Client, Address } from '../../../generated/prisma/client';

/** Заказ вместе со связанными клиентом и адресом (для рендера у диспетчера). */
export type OrderWithRelations = Order & { client: Client; address: Address };

/**
 * Превью суммы заказа ДО его создания (SPEC §6: экраны CONFIRM_*).
 * Бот рендерит подтверждение по этим данным и сам деньги НЕ считает (CLAUDE.md §1).
 */
export interface OrderQuote {
  isFirstOrder: boolean;
  bottles: number;
  totalPrice: number;
  /** Цена за бутыль — только для повторного заказа (для текста «N × цена»). */
  perBottle: number | null;
  /** Залог за бак — для разбивки стартового комплекта. */
  depositPerBottle: number;
  /** Цена помпы — для разбивки стартового комплекта. */
  pumpPrice: number;
  /** Старт-вода за бак — для разбивки стартового комплекта. */
  waterStartPrice: number;
}

/**
 * Заказы: создание, расчёт суммы (делегирует), смена статусов (SPEC §5, §7, §8).
 * Сервис соединяет clients + pricing-settings + pricing, но сам сумму НЕ считает —
 * это делает PricingService (единственный источник правды, CLAUDE.md §1).
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly pricing: PricingService,
    private readonly pricingSettings: PricingSettingsService,
    @Inject(ORDER_DISPATCHER) private readonly dispatcher: OrderDispatcher,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Последние заказы клиента для экрана «Мои заказы» (SPEC §6). Read-only,
   * новейшие сверху, отменённые включаются (клиент видит и их статус).
   */
  listByClient(clientId: string, limit = 5): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Количество бутылей последнего не-отменённого заказа клиента — для кнопки
   * «Повторить прошлый заказ» (SPEC §6). null, если повторять нечего (нет заказов
   * или все отменены — тогда это фактически первый заказ).
   */
  async lastBottles(clientId: string): Promise<number | null> {
    const last = await this.prisma.order.findFirst({
      where: { clientId, status: { not: OrderStatus.CANCELLED } },
      orderBy: { createdAt: 'desc' },
      select: { bottles: true },
    });
    return last?.bottles ?? null;
  }

  /** Заказ с клиентом и адресом — для перерисовки сообщения у диспетчера (SPEC §7). */
  getOrderView(id: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { id },
      include: { client: true, address: true },
    });
  }

  /**
   * Активные заказы (created/accepted) для команды /orders диспетчера: рабочая
   * очередь, если пуш уехал вверх по чату. Сначала старые (FIFO). limit —
   * страховка от флуда сообщениями в чат.
   */
  listActive(limit = 20): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.CREATED, OrderStatus.ACCEPTED] },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { client: true, address: true },
    });
  }

  /**
   * Сводка для /stats (SPEC §7): число заказов и сумма за сегодня и за последние
   * 7 дней, без отменённых. «Сегодня» — от локальной полуночи, «неделя» —
   * скользящие 7 суток. Полноценная аналитика — отдельный модуль позже.
   */
  async stats(): Promise<{
    today: { count: number; sum: number };
    week: { count: number; sum: number };
  }> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const notCancelled = { status: { not: OrderStatus.CANCELLED } };
    const todayWhere = { ...notCancelled, createdAt: { gte: startOfToday } };
    const weekWhere = { ...notCancelled, createdAt: { gte: weekAgo } };

    const [todayCount, todayAgg, weekCount, weekAgg] =
      await this.prisma.$transaction([
        this.prisma.order.count({ where: todayWhere }),
        this.prisma.order.aggregate({
          where: todayWhere,
          _sum: { totalPrice: true },
        }),
        this.prisma.order.count({ where: weekWhere }),
        this.prisma.order.aggregate({
          where: weekWhere,
          _sum: { totalPrice: true },
        }),
      ]);
    return {
      today: { count: todayCount, sum: todayAgg._sum.totalPrice ?? 0 },
      week: { count: weekCount, sum: weekAgg._sum.totalPrice ?? 0 },
    };
  }

  /**
   * Создаёт заказ со статусом CREATED и зафиксированной totalPrice (SPEC §8).
   * Цены берутся из PriceSettings на момент оформления и не пересчитываются
   * задним числом (SPEC §3.3, §4).
   */
  async createOrder(clientId: string, bottles: number): Promise<Order> {
    const client = await this.clients.getById(clientId);
    if (!client) {
      throw new Error(`client not found: ${clientId}`);
    }

    const address = await this.clients.getDefaultAddress(clientId);
    if (!address) {
      throw new Error(`client ${clientId} has no default address`);
    }

    const isFirstOrder = await this.isFirstOrder(clientId);
    const prices = await this.pricingSettings.getCurrent();
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      isFirstOrder,
      prices,
    );

    const order = await this.prisma.order.create({
      data: {
        clientId,
        addressId: address.id,
        bottles,
        isFirstOrder,
        totalPrice,
        status: OrderStatus.CREATED,
      },
    });

    await this.dispatcher.notifyNewOrder(order, client, address);

    return order;
  }

  /**
   * Считает превью суммы для экрана подтверждения (SPEC §6), не создавая заказ.
   * Использует те же pricing/pricing-settings, что и createOrder — единый
   * источник правды по сумме (CLAUDE.md §1). perBottle выводится из totalPrice,
   * чтобы не дублировать выбор ценовой ветки из PricingService.
   */
  async quote(clientId: string, bottles: number): Promise<OrderQuote> {
    const isFirstOrder = await this.isFirstOrder(clientId);
    const prices = await this.pricingSettings.getCurrent();
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      isFirstOrder,
      prices,
    );
    return {
      isFirstOrder,
      bottles,
      totalPrice,
      perBottle: isFirstOrder ? null : totalPrice / bottles,
      depositPerBottle: prices.depositPerBottle,
      pumpPrice: prices.pumpPrice,
      waterStartPrice: prices.waterStartPrice,
    };
  }

  /**
   * Правка количества бутылей в активном заказе диспетчером (SPEC §7, кнопка
   * «✏️ Изменить»): пересчитывает totalPrice через pricing (по isFirstOrder
   * заказа и текущим ценам). Это осознанный ручной оверрайд — фиксация цены при
   * создании (§4) защищает от АВТО-пересчёта при смене прайса, а не от правки
   * диспетчером. Разрешено только для created/accepted.
   */
  async editQuantity(
    orderId: string,
    bottles: number,
  ): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new Error(`cannot edit order ${orderId} in status ${order.status}`);
    }
    const prices = await this.pricingSettings.getCurrent();
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      order.isFirstOrder,
      prices,
    );
    return this.prisma.order.update({
      where: { id: orderId },
      data: { bottles, totalPrice },
      include: { client: true, address: true },
    });
  }

  /** CREATED → ACCEPTED (SPEC §7). */
  async acceptOrder(id: string): Promise<Order> {
    const order = await this.transition(
      id,
      OrderStatus.CREATED,
      OrderStatus.ACCEPTED,
      { acceptedAt: new Date() },
    );
    this.emitStatusChanged(order);
    return order;
  }

  /** ACCEPTED → DELIVERED (SPEC §7, §8). */
  async markDelivered(id: string): Promise<Order> {
    const order = await this.transition(
      id,
      OrderStatus.ACCEPTED,
      OrderStatus.DELIVERED,
      { deliveredAt: new Date() },
    );
    this.emitStatusChanged(order);
    return order;
  }

  /** CREATED/ACCEPTED → CANCELLED. Доставленный или уже отменённый — нельзя. */
  async cancelOrder(id: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id } });
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new Error(`cannot cancel order ${id} in status ${order.status}`);
    }
    const cancelled = await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED },
    });
    this.emitStatusChanged(cancelled);
    return cancelled;
  }

  /**
   * Оповещает подписчиков о смене статуса заказа диспетчером (клиентский бот
   * уведомит клиента, SPEC §8). Только для диспетчерских переходов — отмену
   * клиентом (cancelOwnOrder) сюда НЕ заводим.
   */
  private emitStatusChanged(order: Order): void {
    const payload: OrderStatusChangedEvent = { order };
    this.events.emit(ORDER_STATUS_CHANGED, payload);
  }

  /**
   * Отмена заказа самим клиентом из бота (SPEC §9). Разрешена только пока
   * диспетчер не принял (статус CREATED) и только для своего заказа (проверка
   * владельца по clientId — callback можно подделать, CLAUDE.md прав. 8).
   * После отмены шлём диспетчеру уведомление best-effort: его сбой не отменяет
   * саму отмену (прав. 9 — отмена для клиента уже состоялась).
   */
  async cancelOwnOrder(orderId: string, clientId: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (order.clientId !== clientId) {
      throw new Error(`order ${orderId} does not belong to client ${clientId}`);
    }
    if (order.status !== OrderStatus.CREATED) {
      throw new Error(
        `client cannot cancel order ${orderId} in status ${order.status}`,
      );
    }
    // where включает status — атомарный гард от гонки с принятием диспетчером.
    const cancelled = await this.prisma.order.update({
      where: { id: orderId, status: OrderStatus.CREATED },
      data: { status: OrderStatus.CANCELLED },
    });

    const client = await this.clients.getById(clientId);
    if (client) {
      try {
        await this.dispatcher.notifyClientCancelled(cancelled, client);
      } catch (err) {
        this.logger.error(
          `notifyClientCancelled failed for order ${orderId}: ${(err as Error).message}`,
        );
      }
    }
    return cancelled;
  }

  /**
   * Первый заказ = у клиента нет ни одного заказа со статусом, отличным от
   * CANCELLED (SPEC §5). Отменённые заказы «не считаются».
   */
  private async isFirstOrder(clientId: string): Promise<boolean> {
    const activeCount = await this.prisma.order.count({
      where: { clientId, status: { not: OrderStatus.CANCELLED } },
    });
    return activeCount === 0;
  }

  /** Смена статуса с проверкой допустимого перехода from → to. */
  private async transition(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    extra: { acceptedAt?: Date; deliveredAt?: Date } = {},
  ): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id } });
    if (order.status !== from) {
      throw new Error(
        `invalid transition for order ${id}: ${order.status} → ${to} (expected from ${from})`,
      );
    }
    return this.prisma.order.update({
      where: { id, status: from },
      data: { status: to, ...extra },
    });
  }
}
