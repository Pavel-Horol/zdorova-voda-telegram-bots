import { collectConfigWarnings, supportPhoneConfigured } from './env-check';

const fullEnv = {
  DATABASE_URL: 'postgresql://aqua:aqua@localhost:5432/aqua',
  CLIENT_BOT_TOKEN: 'c-token',
  DISPATCHER_BOT_TOKEN: 'd-token',
  DISPATCHER_CHAT_ID: '123',
  SUPPORT_PHONE: '+380501234567',
};

describe('collectConfigWarnings', () => {
  it('fully configured → no warnings', () => {
    expect(collectConfigWarnings(fullEnv)).toEqual([]);
  });

  it('flags each missing critical var (SUPPORT_PHONE handled separately, fatal)', () => {
    const warnings = collectConfigWarnings({});
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DATABASE_URL'),
        expect.stringContaining('CLIENT_BOT_TOKEN'),
        expect.stringContaining('DISPATCHER_BOT_TOKEN'),
        expect.stringContaining('DISPATCHER_CHAT_ID'),
      ]),
    );
    // SUPPORT_PHONE is no longer a soft warning — it gates a fatal boot check.
    expect(warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('SUPPORT_PHONE')]),
    );
  });

  it('treats blank/whitespace as missing', () => {
    expect(
      collectConfigWarnings({ ...fullEnv, DISPATCHER_CHAT_ID: '   ' }),
    ).toEqual([expect.stringContaining('DISPATCHER_CHAT_ID')]);
  });
});

describe('supportPhoneConfigured', () => {
  it('true for a real number', () => {
    expect(supportPhoneConfigured(fullEnv)).toBe(true);
  });

  it('false when missing or blank', () => {
    expect(supportPhoneConfigured({})).toBe(false);
    expect(supportPhoneConfigured({ SUPPORT_PHONE: '   ' })).toBe(false);
  });

  it('false for the leftover .env.example placeholder (contains an X)', () => {
    expect(supportPhoneConfigured({ SUPPORT_PHONE: '+380XXXXXXXXX' })).toBe(
      false,
    );
  });
});
