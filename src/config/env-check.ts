/**
 * Startup configuration self-check (pure, no side effects — so it is unit-tested).
 * The app degrades gracefully on missing env (bots simply don't start, the support
 * phone falls back to a placeholder), which makes a misconfiguration easy to miss.
 * This turns that silent degradation into a clear boot-time warning list. NON-fatal:
 * a partial local run (e.g. only the client bot) stays possible.
 */
export type EnvLike = Record<string, string | undefined>;

/** Critical vars whose absence breaks a core function — reported at startup. */
const REQUIRED: ReadonlyArray<readonly [key: string, impact: string]> = [
  ['DATABASE_URL', 'немає підключення до БД'],
  ['CLIENT_BOT_TOKEN', 'клієнтський бот не запуститься'],
  ['DISPATCHER_BOT_TOKEN', 'диспетчерський бот не запуститься'],
  ['DISPATCHER_CHAT_ID', 'замовлення не дійдуть диспетчеру'],
];

/**
 * Collects human-readable warnings about missing/placeholder critical config.
 * Empty array = everything essential is set. The support phone is flagged when unset
 * OR still the `.env.example` placeholder (contains an "X"), since the client would
 * otherwise be shown a bogus number.
 */
export function collectConfigWarnings(env: EnvLike): string[] {
  const warnings: string[] = [];
  for (const [key, impact] of REQUIRED) {
    if (!env[key]?.trim()) warnings.push(`${key} не задано — ${impact}`);
  }
  const phone = env.SUPPORT_PHONE?.trim();
  if (!phone || phone.includes('X')) {
    warnings.push(
      'SUPPORT_PHONE не задано або лишилась заглушка — клієнт побачить некоректний номер',
    );
  }
  return warnings;
}
