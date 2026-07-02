-- CreateTable
CREATE TABLE "Dispatcher" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dispatcher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispatcher_chatId_key" ON "Dispatcher"("chatId");
