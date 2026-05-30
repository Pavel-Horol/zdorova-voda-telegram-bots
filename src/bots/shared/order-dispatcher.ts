import { Injectable, Logger } from '@nestjs/common';
import type { Order } from '../../../generated/prisma/client';

/**
 * DI-токен для OrderDispatcher. Интерфейсы в рантайме не существуют, поэтому
 * провайдер регистрируется и инжектится по этому токену (см. OrdersModule).
 */
export const ORDER_DISPATCHER = Symbol('ORDER_DISPATCHER');

/**
 * Абстракция «куда уходит готовый заказ» (CLAUDE.md §2, SPEC §10).
 * Бизнес-логика заказа НЕ знает, кто получает уведомление: сейчас это будет
 * диспетчерский бот, в v2 — ViberDispatcher, без правок в orders.
 */
export interface OrderDispatcher {
  dispatch(order: Order): Promise<void>;
}

/**
 * Заглушка на время, пока ботов нет: ничего не отправляет, только логирует.
 * Реальная реализация (отправка в диспетчерский бот) появится в задаче про ботов.
 */
@Injectable()
export class NoopOrderDispatcher implements OrderDispatcher {
  private readonly logger = new Logger(NoopOrderDispatcher.name);

  dispatch(order: Order): Promise<void> {
    this.logger.debug(`Order ${order.id} ready to dispatch (noop)`);
    return Promise.resolve();
  }
}
