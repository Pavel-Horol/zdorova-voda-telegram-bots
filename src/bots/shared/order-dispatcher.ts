import { Injectable, Logger } from '@nestjs/common';
import type { Order, Client, Address } from '../../../generated/prisma/client';

/**
 * DI token for OrderDispatcher. Interfaces do not exist at runtime, so the provider
 * is registered and injected by this token (see OrdersModule).
 */
export const ORDER_DISPATCHER = Symbol('ORDER_DISPATCHER');

/**
 * Abstraction of "where a completed order goes" (CLAUDE.md §2, SPEC §10).
 * The order business logic does NOT know who receives the notification: currently
 * it is the dispatcher bot, in v2 — another channel/implementation, with no changes in orders.
 *
 * order/client/address are passed in ready: OrdersService already loaded them at
 * ordering time, so the dispatcher does NOT hit the DB itself (CLAUDE.md §6).
 */
export interface OrderDispatcher {
  notifyNewOrder(order: Order, client: Client, address: Address): Promise<void>;
  /**
   * The order was cancelled by the client themselves from the bot (SPEC §9). The
   * dispatcher's message with inline buttons is stale by now — send a separate notification.
   */
  notifyClientCancelled(order: Order, client: Client): Promise<void>;
  /**
   * The client picked a non-standard onboarding case ("Other") that the dispatcher
   * handles by phone — notify the dispatcher to call the client back (no order yet).
   */
  notifyCallbackRequest(client: Client): Promise<void>;
}

/**
 * A logging implementation for development and tests: writes the order to the log
 * and sends nothing. Lets you create an order and see the notification "fire"
 * without live bots and tokens.
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
      `New order ${order.id}: ${order.bottles} bottles, ${order.totalPrice} UAH — ` +
        `${client.name ?? 'no name'} ${client.phone}, ${address.raw}`,
    );
    return Promise.resolve();
  }

  notifyClientCancelled(order: Order, client: Client): Promise<void> {
    this.logger.log(`Order ${order.id} cancelled by client ${client.phone}`);
    return Promise.resolve();
  }

  notifyCallbackRequest(client: Client): Promise<void> {
    this.logger.log(
      `Callback requested by client ${client.phone} (${client.name ?? 'no name'})`,
    );
    return Promise.resolve();
  }
}
