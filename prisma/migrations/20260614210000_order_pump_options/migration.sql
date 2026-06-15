-- Order pump options: electric in the kit, pump add-on for own bottles (STEP3 T5).
ALTER TABLE "Order" ADD COLUMN "electro" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pumpAddon" BOOLEAN NOT NULL DEFAULT false;
