import { demoTransitionDelayMs, nextDemoTransition } from './demo.fsm';
import { OrderStatus } from '../../../generated/prisma/enums';

describe('nextDemoTransition', () => {
  it('CREATED → accept', () => {
    expect(nextDemoTransition(OrderStatus.CREATED)).toBe('accept');
  });

  it('ACCEPTED → deliver', () => {
    expect(nextDemoTransition(OrderStatus.ACCEPTED)).toBe('deliver');
  });

  it('terminal statuses → nothing (a cancelled demo order stays cancelled)', () => {
    expect(nextDemoTransition(OrderStatus.DELIVERED)).toBeNull();
    expect(nextDemoTransition(OrderStatus.CANCELLED)).toBeNull();
  });
});

describe('demoTransitionDelayMs', () => {
  const delays = { acceptMs: 25_000, deliverMs: 45_000 };

  it('picks the delay of the given transition', () => {
    expect(demoTransitionDelayMs('accept', delays)).toBe(25_000);
    expect(demoTransitionDelayMs('deliver', delays)).toBe(45_000);
  });
});
