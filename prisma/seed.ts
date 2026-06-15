import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/**
 * Idempotent seed: ensures the PriceSettings singleton row (id=1) exists with
 * default prices (SPEC §3). Without it the very first total calculation would fail —
 * prices come from the DB, not from code.
 *
 * upsert overwrites nothing on a repeat run: if the row already exists, the current
 * (possibly dispatcher-edited) prices stay as they are.
 */
async function main(): Promise<void> {
  const settings = await prisma.priceSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      price1: 80,
      priceFrom2: 70,
      priceFrom6: 65,
      depositPerBottle: 450,
      pumpPrice: 250,
      electroPumpPrice: 270,
      waterStartPrice: 50,
    },
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
