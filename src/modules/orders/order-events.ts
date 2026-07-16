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

/**
 * Name of the order-edited event: the dispatcher changed the order's content
 * (bottle quantity / delivery address / comment) without a status change. Emitted
 * from OrdersService on a dispatcher edit; the client bot listens and notifies the
 * client that their order was updated. Not emitted for internal-only edits (geo
 * tagging, OWN_TARA claim correction) that do not affect what the client ordered.
 */
export const ORDER_EDITED = 'order.edited';

export interface OrderEditedEvent {
  order: Order;
}

/**
 * Name of the delivery-note event: the dispatcher set/updated the delivery-timing
 * message for the client ("сьогодні", "перенесено на завтра", …). Emitted from
 * OrdersService; the client bot listens and pushes the client. Fire-and-forget, like
 * the other order events — the listener swallows its own errors (CLAUDE.md rule 10).
 */
export const ORDER_DELIVERY_NOTE = 'order.delivery-note';

export interface OrderDeliveryNoteEvent {
  order: Order;
}
