/**
 * Pure transition logic of the demo stand's simulated dispatcher (CLAUDE.md
 * "Тестирование": pure functions, no ctx / services / async — data comes ready).
 * The service around it only schedules timers and calls OrdersService.
 */
import { OrderStatus } from '../../../generated/prisma/enums';
import type { DemoDelays } from '../../config/demo';

/** What the simulated dispatcher does next to an order. */
export type DemoTransition = 'accept' | 'deliver';

/**
 * The next automatic transition for an order in `status`, or null when there is
 * nothing left to do. DELIVERED and CANCELLED are terminal — a cancelled demo order
 * must stay cancelled (a visitor who cancels their own order sees it stick).
 */
export function nextDemoTransition(status: OrderStatus): DemoTransition | null {
  switch (status) {
    case OrderStatus.CREATED:
      return 'accept';
    case OrderStatus.ACCEPTED:
      return 'deliver';
    default:
      return null;
  }
}

/** How long to wait before performing `transition` (ms). */
export function demoTransitionDelayMs(
  transition: DemoTransition,
  delays: DemoDelays,
): number {
  return transition === 'accept' ? delays.acceptMs : delays.deliverMs;
}
