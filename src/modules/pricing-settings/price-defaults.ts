/**
 * Default price grid (PRODUCT.md "Pricing") — the single source shared by the DB seed
 * (prisma/seed.ts) and the demo stand's periodic reset, so "defaults" cannot drift
 * between them. A leaf file on purpose: no Nest, no Prisma, so the seed script can
 * import it without pulling the application in.
 *
 * These are only STARTING values. In a live system prices are the dispatcher's to
 * change from the bot; nothing recomputes an existing order against them (rule 3).
 */
export const DEFAULT_PRICE_SETTINGS = {
  /** Water grid (city) by quantity: 1 / from 2 / from 6. */
  price1: 80,
  priceFrom2: 70,
  priceFrom6: 65,
  /** Starter-kit and add-on components: deposit, pump, electric pump, starter water. */
  depositPerBottle: 450,
  pumpPrice: 250,
  electroPumpPrice: 270,
  waterStartPrice: 50,
} as const;
