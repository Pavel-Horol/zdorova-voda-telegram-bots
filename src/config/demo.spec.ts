import {
  DEMO_VISITOR_PHONE_PREFIX,
  demoCleanupIntervalMs,
  demoDelays,
  demoPhone,
  demoTtlHours,
  isDemoMode,
  resolveOrderChannel,
} from './demo';

describe('isDemoMode', () => {
  it('true for the accepted truthy spellings, case-insensitive', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(isDemoMode({ DEMO_MODE: raw })).toBe(true);
    }
  });

  it('false when missing, blank or anything else', () => {
    for (const raw of [undefined, '', '   ', '0', 'false', 'no', 'demo']) {
      expect(isDemoMode({ DEMO_MODE: raw })).toBe(false);
    }
  });
});

describe('resolveOrderChannel', () => {
  it('demo goes to telegram — the buyer must see the card in the dispatcher bot', () => {
    expect(resolveOrderChannel({ DEMO_MODE: 'true' })).toBe('telegram');
    // …even when NODE_ENV is not production (local demo run).
    expect(
      resolveOrderChannel({ DEMO_MODE: 'true', NODE_ENV: 'development' }),
    ).toBe('telegram');
  });

  it('production without demo — telegram (unchanged behaviour)', () => {
    expect(resolveOrderChannel({ NODE_ENV: 'production' })).toBe('telegram');
  });

  it('any other run — log (local dev without tokens)', () => {
    expect(resolveOrderChannel({})).toBe('log');
    expect(resolveOrderChannel({ NODE_ENV: 'development' })).toBe('log');
    expect(resolveOrderChannel({ NODE_ENV: 'test' })).toBe('log');
  });
});

describe('demoPhone', () => {
  it('derives a stable fake number with the visitor prefix', () => {
    expect(demoPhone(123456789n)).toBe(`${DEMO_VISITOR_PHONE_PREFIX}123456789`);
    expect(demoPhone(123456789n)).toBe(demoPhone(123456789n));
  });

  it('pads short ids and keeps the last 9 digits of long ones', () => {
    expect(demoPhone(42n)).toBe(`${DEMO_VISITOR_PHONE_PREFIX}000000042`);
    expect(demoPhone(1234567890123n)).toBe(
      `${DEMO_VISITOR_PHONE_PREFIX}567890123`,
    );
  });

  it('different ids → different numbers (Client.phone is unique)', () => {
    expect(demoPhone(1n)).not.toBe(demoPhone(2n));
  });
});

describe('demoDelays', () => {
  it('defaults tuned for a live demo: 25 s to accept, 45 s to deliver', () => {
    expect(demoDelays({})).toEqual({ acceptMs: 25_000, deliverMs: 45_000 });
  });

  it('reads seconds from env', () => {
    expect(
      demoDelays({ DEMO_ACCEPT_DELAY_SEC: '5', DEMO_DELIVER_DELAY_SEC: '10' }),
    ).toEqual({ acceptMs: 5_000, deliverMs: 10_000 });
  });

  it('falls back on garbage and out-of-range values (never a 0 ms timer)', () => {
    for (const raw of ['0', '-5', 'soon', '2.5', '99999', '']) {
      expect(demoDelays({ DEMO_ACCEPT_DELAY_SEC: raw }).acceptMs).toBe(25_000);
    }
  });
});

describe('demoTtlHours', () => {
  it('defaults to a day', () => {
    expect(demoTtlHours({})).toBe(24);
  });

  it('allows 0 — wipe visitors on every pass (used to verify the sweep)', () => {
    expect(demoTtlHours({ DEMO_TTL_HOURS: '0' })).toBe(0);
  });

  it('falls back on garbage and negatives', () => {
    expect(demoTtlHours({ DEMO_TTL_HOURS: '-1' })).toBe(24);
    expect(demoTtlHours({ DEMO_TTL_HOURS: 'never' })).toBe(24);
  });
});

describe('demoCleanupIntervalMs', () => {
  it('defaults to hourly', () => {
    expect(demoCleanupIntervalMs({})).toBe(60 * 60_000);
  });

  it('reads minutes from env, falling back on garbage', () => {
    expect(demoCleanupIntervalMs({ DEMO_CLEANUP_INTERVAL_MIN: '5' })).toBe(
      5 * 60_000,
    );
    expect(demoCleanupIntervalMs({ DEMO_CLEANUP_INTERVAL_MIN: '0' })).toBe(
      60 * 60_000,
    );
  });
});
