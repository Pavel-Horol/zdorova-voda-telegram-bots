import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrdersService } from '../orders/orders.service';
import {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  type OrderCreatedEvent,
  type OrderStatusChangedEvent,
} from '../orders/order-events';
import { demoDelays } from '../../config/demo';
import { demoTransitionDelayMs, nextDemoTransition } from './demo.fsm';
import type { Order } from '../../../generated/prisma/client';
import type { DemoTransition } from './demo.fsm';

/**
 * The demo stand's simulated dispatcher: a visitor who is alone with the bot still sees
 * the full chain — order → "прийнято" → "доставлено" — because this service accepts and
 * delivers on a timer. Those pushes are what the demo is for.
 *
 * It reacts to EVENTS, never being called by OrdersService (CLAUDE.md rule 10): the
 * order logic has no idea a simulated dispatcher exists, and this module is only
 * registered when DEMO_MODE is on. Listening to the status change (not just creation)
 * means a buyer who taps "Прийняти" in the dispatcher bot themselves still gets the
 * delivery leg automatically, and a cancelled order simply stops the chain.
 *
 * Timers live in memory: a restart forgets what was scheduled (the order stays in its
 * current status). Acceptable for a stand — documented in DEMO.md, not worth a queue.
 */
@Injectable()
export class DemoAutoDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(DemoAutoDispatcherService.name);
  private readonly delays = demoDelays(process.env);
  /** Pending transition per order id — so a status change can replace it, not stack. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly orders: OrdersService) {}

  /** A visitor placed an order → schedule the automatic acceptance. */
  @OnEvent(ORDER_CREATED)
  onOrderCreated(event: OrderCreatedEvent): void {
    this.schedule(event.order);
  }

  /**
   * The order moved on — by our own timer or by a human in the dispatcher bot.
   * Re-plans from the CURRENT status, which both continues the chain after a manual
   * acceptance and drops the pending timer of a cancelled order.
   */
  @OnEvent(ORDER_STATUS_CHANGED)
  onOrderStatusChanged(event: OrderStatusChangedEvent): void {
    this.schedule(event.order);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Replaces the order's pending transition with the one its current status implies. */
  private schedule(order: Order): void {
    const pending = this.timers.get(order.id);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(order.id);
    }

    const next = nextDemoTransition(order.status);
    if (!next) return;

    const timer = setTimeout(
      () => {
        this.timers.delete(order.id);
        void this.run(order.id, next);
      },
      demoTransitionDelayMs(next, this.delays),
    );
    // Never keep the process alive just to finish a demo order.
    timer.unref();
    this.timers.set(order.id, timer);
  }

  /**
   * Performs the transition. Fire-and-forget like every event listener here: the order
   * may have been cancelled, already moved by a human, or deleted by `/reset` while the
   * timer was pending — OrdersService throws on such a transition, and that is fine.
   */
  private async run(
    orderId: string,
    transition: DemoTransition,
  ): Promise<void> {
    try {
      if (transition === 'accept') await this.orders.acceptOrder(orderId);
      else await this.orders.markDelivered(orderId);
      this.logger.log(`demo auto-${transition} for order ${orderId}`);
    } catch (err) {
      this.logger.debug(
        `demo auto-${transition} skipped for order ${orderId}: ${(err as Error).message}`,
      );
    }
  }
}
