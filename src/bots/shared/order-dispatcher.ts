import { Injectable, Logger } from '@nestjs/common';
import type { Order, Client, Address } from '../../../generated/prisma/client';

/**
 * DI-токен для OrderDispatcher. Интерфейсы в рантайме не существуют, поэтому
 * провайдер регистрируется и инжектится по этому токену (см. OrdersModule).
 */
export const ORDER_DISPATCHER = Symbol('ORDER_DISPATCHER');

/**
 * Абстракция «куда уходит готовый заказ» (CLAUDE.md §2, SPEC §10).
 * Бизнес-логика заказа НЕ знает, кто получает уведомление: сейчас это
 * диспетчерский бот, в v2 — ViberDispatcher, без правок в orders.
 *
 * order/client/address передаются готовыми: OrdersService уже загрузил их при
 * оформлении, поэтому dispatcher НЕ ходит в БД сам (CLAUDE.md §6).
 */
export interface OrderDispatcher {
  notifyNewOrder(order: Order, client: Client, address: Address): Promise<void>;
}

/**
 * Логирующая реализация для разработки и тестов: пишет заказ в лог и ничего
 * не отправляет. Позволяет создать заказ и увидеть, что уведомление «вызвалось»,
 * без живых ботов и токенов.
 */
@Injectable()
export class LogOrderDispatcher implements OrderDispatcher {
  private readonly logger = new Logger(LogOrderDispatcher.name);

  notifyNewOrder(
    order: Order,
    client: Client,
    address: Address,
  ): Promise<void> {
    this.logger.log(
      `New order ${order.id}: ${order.bottles} бут., ${order.totalPrice} грн — ` +
        `${client.name ?? 'без имени'} ${client.phone}, ${address.raw}`,
    );
    return Promise.resolve();
  }
}
