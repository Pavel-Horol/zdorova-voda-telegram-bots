import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { DEFAULT_PRICE_SETTINGS } from '../src/modules/pricing-settings/price-defaults';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/**
 * Idempotent seed: ensures the PriceSettings singleton row (id=1) exists with
 * default prices (SPEC §3, DEFAULT_PRICE_SETTINGS — shared with the demo reset so the
 * two cannot drift). Without it the very first total calculation would fail —
 * prices come from the DB, not from code.
 *
 * upsert overwrites nothing on a repeat run: if the row already exists, the current
 * (possibly dispatcher-edited) prices stay as they are.
 */
async function main(): Promise<void> {
  const settings = await prisma.priceSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, ...DEFAULT_PRICE_SETTINGS },
  });

  console.log('PriceSettings ready:', settings);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
