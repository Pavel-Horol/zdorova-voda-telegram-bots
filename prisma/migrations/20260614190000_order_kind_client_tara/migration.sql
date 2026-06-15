-- Order kind instead of isFirstOrder + client tara/pump state (PRODUCT.md, STEP3 T1).

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('STARTER_KIT', 'OWN_TARA', 'REPEAT');

-- Order: add kind, backfill from isFirstOrder, drop isFirstOrder.
ALTER TABLE "Order" ADD COLUMN "kind" "OrderKind";
UPDATE "Order"
   SET "kind" = CASE WHEN "isFirstOrder" THEN 'STARTER_KIT'::"OrderKind"
                     ELSE 'REPEAT'::"OrderKind" END;
ALTER TABLE "Order" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "Order" DROP COLUMN "isFirstOrder";

-- Client: tara/pump state (defaults for existing clients).
ALTER TABLE "Client" ADD COLUMN "bottlesOnHand" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "hasPump" BOOLEAN NOT NULL DEFAULT false;
