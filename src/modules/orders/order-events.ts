import type { Order } from '../../../generated/prisma/client';

/**
 * Имя события смены статуса заказа диспетчером (SPEC §7/§8). Эмитится из
 * OrdersService при accept/deliver/cancel; клиентский бот слушает и уведомляет
 * клиента. Самостоятельную отмену клиентом (cancelOwnOrder) НЕ эмитим — клиент
 * её инициировал и уже увидел результат.
 */
export const ORDER_STATUS_CHANGED = 'order.status.changed';

export interface OrderStatusChangedEvent {
  order: Order;
}
