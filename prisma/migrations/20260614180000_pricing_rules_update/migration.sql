-- Price from 2026-05-12 (PRODUCT.md "Pricing"):
-- water grid 1 / from 2 / from 6, deposit 450, pump 250 + electro 270, starter water 50.

-- AlterTable
ALTER TABLE "PriceSettings" DROP COLUMN "price2",
DROP COLUMN "price3plus",
ADD COLUMN     "electroPumpPrice" INTEGER NOT NULL DEFAULT 270,
ADD COLUMN     "priceFrom2" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "priceFrom6" INTEGER NOT NULL DEFAULT 65,
ADD COLUMN     "waterStartPrice" INTEGER NOT NULL DEFAULT 50,
ALTER COLUMN "depositPerBottle" SET DEFAULT 450,
ALTER COLUMN "pumpPrice" SET DEFAULT 250;

-- SET DEFAULT does not touch existing rows — bring the singleton to the current prices.
UPDATE "PriceSettings" SET "depositPerBottle" = 450, "pumpPrice" = 250 WHERE "id" = 1;
