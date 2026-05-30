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
import type { Order } from '../../../generated/prisma/client';

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

  getById(id: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id } });
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

    await this.dispatcher.dispatch(order);

    return order;
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
      where: { id },
      data: { status: to, ...extra },
    });
  }
}
