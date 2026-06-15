-- Тип заказа вместо isFirstOrder + состояние тары/помпы клиента (PRODUCT.md, STEP3 T1).

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('STARTER_KIT', 'OWN_TARA', 'REPEAT');

-- Order: добавляем kind, бэкфиллим из isFirstOrder, дропаем isFirstOrder.
ALTER TABLE "Order" ADD COLUMN "kind" "OrderKind";
UPDATE "Order"
   SET "kind" = CASE WHEN "isFirstOrder" THEN 'STARTER_KIT'::"OrderKind"
                     ELSE 'REPEAT'::"OrderKind" END;
ALTER TABLE "Order" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "Order" DROP COLUMN "isFirstOrder";

-- Client: состояние тары/помпы (дефолты для существующих клиентов).
ALTER TABLE "Client" ADD COLUMN "bottlesOnHand" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "hasPump" BOOLEAN NOT NULL DEFAULT false;
