import {
  demoTransitionDelayMs,
  nextDemoTransition,
  pickFeedOrder,
} from './demo.fsm';
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

describe('pickFeedOrder', () => {
  const clients = ['c1', 'c2', 'c3'];

  it('walks the clients in order', () => {
    expect(pickFeedOrder(0, clients)?.clientId).toBe('c1');
    expect(pickFeedOrder(1, clients)?.clientId).toBe('c2');
    expect(pickFeedOrder(3, clients)?.clientId).toBe('c1');
  });

  it('varies the size independently, so the queue does not repeat itself', () => {
    const first = pickFeedOrder(0, clients)!;
    const sameClientAgain = pickFeedOrder(3, clients)!;
    expect(sameClientAgain.clientId).toBe(first.clientId);
    expect(sameClientAgain.bottles).not.toBe(first.bottles);
  });

  it('always asks for a plausible amount', () => {
    for (let seq = 0; seq < 20; seq += 1) {
      const spec = pickFeedOrder(seq, clients)!;
      expect(spec.bottles).toBeGreaterThanOrEqual(1);
      expect(spec.bottles).toBeLessThanOrEqual(6);
    }
  });

  it('no showcase yet → nothing to place', () => {
    expect(pickFeedOrder(0, [])).toBeNull();
  });
});
