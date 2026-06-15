-- Flag "claimed existing, not verified" for the "I am already your client" onboarding (STEP3 T4).
ALTER TABLE "Client" ADD COLUMN "pendingReview" BOOLEAN NOT NULL DEFAULT false;
