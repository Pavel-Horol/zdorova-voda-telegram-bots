/**
 * Startup configuration self-check (pure, no side effects — so it is unit-tested).
 * Two levels: {@link collectConfigWarnings} lists missing vars that only degrade
 * gracefully (a bot that doesn't start), while {@link supportPhoneConfigured} gates a
 * FATAL check in main.ts — SUPPORT_PHONE is the guaranteed fallback for "Зв'язатися",
 * so the app refuses to boot without a real number (never a client-facing dead end).
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
 * Collects human-readable warnings about missing critical config (NON-fatal: a partial
 * local run, e.g. only the client bot, stays possible). Empty array = all essential set.
 * SUPPORT_PHONE is handled separately (fatal) — see {@link supportPhoneConfigured}.
 */
export function collectConfigWarnings(env: EnvLike): string[] {
  const warnings: string[] = [];
  for (const [key, impact] of REQUIRED) {
    if (!env[key]?.trim()) warnings.push(`${key} не задано — ${impact}`);
  }
  return warnings;
}

/**
 * Whether SUPPORT_PHONE holds a real number: set and not the `.env.example` placeholder
 * (which contains an "X"). It is the guaranteed fallback shown on "Зв'язатися" when the
 * dispatcher has no active number, so main.ts refuses to boot when this is false.
 */
export function supportPhoneConfigured(env: EnvLike): boolean {
  const phone = env.SUPPORT_PHONE?.trim();
  return !!phone && !phone.includes('X');
}
