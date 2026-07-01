import { collectConfigWarnings } from './env-check';

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

  it('flags each missing critical var', () => {
    const warnings = collectConfigWarnings({});
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DATABASE_URL'),
        expect.stringContaining('CLIENT_BOT_TOKEN'),
        expect.stringContaining('DISPATCHER_BOT_TOKEN'),
        expect.stringContaining('DISPATCHER_CHAT_ID'),
        expect.stringContaining('SUPPORT_PHONE'),
      ]),
    );
  });

  it('treats blank/whitespace as missing', () => {
    expect(
      collectConfigWarnings({ ...fullEnv, DISPATCHER_CHAT_ID: '   ' }),
    ).toEqual([expect.stringContaining('DISPATCHER_CHAT_ID')]);
  });

  it('flags the leftover SUPPORT_PHONE placeholder (contains an X)', () => {
    expect(
      collectConfigWarnings({ ...fullEnv, SUPPORT_PHONE: '+380XXXXXXXXX' }),
    ).toEqual([expect.stringContaining('SUPPORT_PHONE')]);
  });
});
