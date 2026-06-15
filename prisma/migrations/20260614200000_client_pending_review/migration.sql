-- Флаг «заявлен действующим, не сверён» для онбординга «я уже ваш клиент» (STEP3 T4).
ALTER TABLE "Client" ADD COLUMN "pendingReview" BOOLEAN NOT NULL DEFAULT false;
