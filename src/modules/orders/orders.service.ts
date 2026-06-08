import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from '../clients/clients.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import {
  ORDER_DISPATCHER,
  type OrderDispatcher,
} from '../../bots/shared/order-dispatcher';
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
  /** Залог за бутыль — для текста первого заказа. */
  depositPerBottle: number;
  /** Цена помпы — для текста первого заказа. */
  pumpPrice: number;
}

/**
 * Заказы: создание, расчёт суммы (делегирует), смена статусов (SPEC §5, §7, §8).
 * Сервис соединяет clients + pricing-settings + pricing, но сам сумму НЕ считает —
 * это делает PricingService (единственный источник правды, CLAUDE.md §1).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly pricing: PricingService,
    private readonly pricingSettings: PricingSettingsService,
    @Inject(ORDER_DISPATCHER) private readonly dispatcher: OrderDispatcher,
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

  /** Заказ с клиентом и адресом — для перерисовки сообщения у диспетчера (SPEC §7). */
  getOrderView(id: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { id },
      include: { client: true, address: true },
    });
  }

  /**
   * Минимальная сводка за сегодня для /stats (SPEC §7): число заказов и сумма,
   * без отменённых. Полноценная статистика — отдельный модуль позже.
   */
  async statsToday(): Promise<{ count: number; sum: number }> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const where = {
      createdAt: { gte: since },
      status: { not: OrderStatus.CANCELLED },
    };
    const [count, agg] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.aggregate({ where, _sum: { totalPrice: true } }),
    ]);
    return { count, sum: agg._sum.totalPrice ?? 0 };
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
    };
  }

  /** CREATED → ACCEPTED (SPEC §7). */
  acceptOrder(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.CREATED, OrderStatus.ACCEPTED, {
      acceptedAt: new Date(),
    });
  }

  /** ACCEPTED → DELIVERED (SPEC §7, §8). */
  markDelivered(id: string): Promise<Order> {
    return this.transition(id, OrderStatus.ACCEPTED, OrderStatus.DELIVERED, {
      deliveredAt: new Date(),
    });
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
    return this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED },
    });
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
