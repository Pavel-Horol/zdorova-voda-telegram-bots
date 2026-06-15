import type { Order } from '../../../generated/prisma/client';

/**
 * Name of the order status-change event by the dispatcher (SPEC §7/§8). Emitted from
 * OrdersService on accept/deliver/cancel; the client bot listens and notifies the
 * client. Self-cancellation by the client (cancelOwnOrder) is NOT emitted — the
 * client initiated it and already saw the result.
 */
export const ORDER_STATUS_CHANGED = 'order.status.changed';

export interface OrderStatusChangedEvent {
  order: Order;
}
