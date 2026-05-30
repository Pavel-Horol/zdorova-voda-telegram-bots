import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/**
 * Идемпотентный сид: гарантирует наличие строки-синглтона PriceSettings (id=1)
 * с дефолтными ценами (SPEC §3). Без неё первый же расчёт суммы упадёт —
 * цены берутся из БД, а не из кода.
 *
 * upsert ничего не перезаписывает на повторном запуске: если строка уже есть,
 * актуальные (возможно отредактированные диспетчером) цены остаются как есть.
 */
async function main(): Promise<void> {
  const settings = await prisma.priceSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      price1: 80,
      price2: 75,
      price3plus: 70,
      depositPerBottle: 300,
      pumpPrice: 200,
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
