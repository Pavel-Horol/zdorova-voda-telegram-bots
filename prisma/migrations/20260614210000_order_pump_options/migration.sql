-- Опции помпы у заказа: электро в комплекте, докупка помпы к своей таре (STEP3 T5).
ALTER TABLE "Order" ADD COLUMN "electro" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pumpAddon" BOOLEAN NOT NULL DEFAULT false;
