-- Прайс с 12.05.2026 (PRODUCT.md «Ценообразование»):
-- сетка воды 1 / от 2 / от 6, залог 450, помпа 250 + электро 270, старт-вода 50.

-- AlterTable
ALTER TABLE "PriceSettings" DROP COLUMN "price2",
DROP COLUMN "price3plus",
ADD COLUMN     "electroPumpPrice" INTEGER NOT NULL DEFAULT 270,
ADD COLUMN     "priceFrom2" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN     "priceFrom6" INTEGER NOT NULL DEFAULT 65,
ADD COLUMN     "waterStartPrice" INTEGER NOT NULL DEFAULT 50,
ALTER COLUMN "depositPerBottle" SET DEFAULT 450,
ALTER COLUMN "pumpPrice" SET DEFAULT 250;

-- SET DEFAULT не трогает существующие строки — приводим синглтон к актуальным ценам.
UPDATE "PriceSettings" SET "depositPerBottle" = 450, "pumpPrice" = 250 WHERE "id" = 1;
