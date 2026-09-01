/**
 * Demo-mode configuration (pure, no side effects — so it is unit-tested, like
 * {@link ./env-check.ts}). The demo stand is a full copy of the bot on its OWN tokens
 * and its OWN database, shown to prospective buyers who walk it alone, without us:
 *
 * - no phone is asked (a deterministic fake one is derived from the Telegram id) —
 *   the demo must not collect real numbers;
 * - the order accepts and delivers itself on a timer, so a single visitor sees the
 *   whole status chain without a second person playing dispatcher;
 * - `/reset` wipes the visitor's own data so onboarding can be replayed;
 * - visitor data is swept periodically and prices are restored.
 *
 * Everything here reads env only — nothing switches on NODE_ENV, so a demo stand can
 * (and does) run with NODE_ENV=production.
 */
import type { EnvLike } from './env-check';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Whether this process runs as the demo stand (DEMO_MODE=1/true/yes/on). */
export function isDemoMode(env: EnvLike): boolean {
  return TRUTHY.has((env.DEMO_MODE ?? '').trim().toLowerCase());
}

/** Where a completed order goes — picks the OrderDispatcher implementation. */
export type OrderChannel = 'telegram' | 'log';

/**
 * Resolves the order channel. Demo is explicitly `telegram`: the stand HAS live
 * dispatcher-bot tokens and the buyer is meant to open the dispatcher side and see the
 * card arrive — logging it would gut the demo. Otherwise the previous rule stands:
 * production sends to Telegram, any other run logs (a local run without tokens works).
 */
export function resolveOrderChannel(env: EnvLike): OrderChannel {
  if (isDemoMode(env)) return 'telegram';
  return env.NODE_ENV === 'production' ? 'telegram' : 'log';
}

/**
 * Phone prefix of a demo VISITOR (a real person poking the stand). Their client row is
 * created with a fake number, and the periodic sweep deletes exactly this prefix — so
 * the showcase rows (see {@link DEMO_SHOWCASE_PHONE_PREFIX}) survive forever.
 */
export const DEMO_VISITOR_PHONE_PREFIX = '+38000';

/**
 * Phone prefix of the seeded SHOWCASE clients — the fake history that makes /orders,
 * /stats and the client lookup non-empty on the buyer's first look. Never swept.
 */
export const DEMO_SHOWCASE_PHONE_PREFIX = '+38001';

/**
 * Fake phone for a demo visitor, derived from their Telegram id: unique (telegramId is
 * unique) and stable across restarts, so a returning visitor is recognised — while no
 * real number is ever stored. Client.phone is `@unique`, hence "derive", not "random".
 */
export function demoPhone(telegramId: bigint): string {
  const digits = (telegramId < 0n ? -telegramId : telegramId)
    .toString()
    .padStart(9, '0')
    .slice(-9);
  return `${DEMO_VISITOR_PHONE_PREFIX}${digits}`;
}

/** Delays of the simulated dispatcher, in milliseconds. */
export interface DemoDelays {
  /** CREATED → ACCEPTED. */
  acceptMs: number;
  /** ACCEPTED → DELIVERED. */
  deliverMs: number;
}

const DEFAULT_ACCEPT_SEC = 25;
const DEFAULT_DELIVER_SEC = 45;
/** Bounds for the auto-dispatcher delays: fast enough to watch, slow enough to read. */
const MIN_DELAY_SEC = 3;
const MAX_DELAY_SEC = 3600;

/**
 * How long the simulated dispatcher waits before accepting / delivering. Defaults are
 * tuned for a live demo (~25 s and ~45 s from ordering): long enough for the buyer to
 * open the dispatcher bot and see the card sitting there unhandled, short enough that
 * nobody walks away. Garbage and out-of-range values fall back to the defaults.
 */
export function demoDelays(env: EnvLike): DemoDelays {
  return {
    acceptMs:
      readBoundedInt(
        env.DEMO_ACCEPT_DELAY_SEC,
        DEFAULT_ACCEPT_SEC,
        MIN_DELAY_SEC,
        MAX_DELAY_SEC,
      ) * 1000,
    deliverMs:
      readBoundedInt(
        env.DEMO_DELIVER_DELAY_SEC,
        DEFAULT_DELIVER_SEC,
        MIN_DELAY_SEC,
        MAX_DELAY_SEC,
      ) * 1000,
  };
}

/**
 * How long a visitor's data lives before the sweep deletes it (hours). 0 is allowed and
 * meaningful — it wipes visitors on every pass (used to verify the sweep).
 */
export function demoTtlHours(env: EnvLike): number {
  return readBoundedInt(env.DEMO_TTL_HOURS, 24, 0, 24 * 365);
}

/** How often the sweep runs (ms). Small values are for verifying it, not for the stand. */
export function demoCleanupIntervalMs(env: EnvLike): number {
  return readBoundedInt(env.DEMO_CLEANUP_INTERVAL_MIN, 60, 1, 24 * 60) * 60_000;
}

/**
 * Parses a non-negative integer from env, falling back to `fallback` when it is
 * missing, not a number, or outside [min, max]. A typo in the demo config must never
 * schedule a timer at 0 ms or at a week.
 */
function readBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw?.trim());
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}
