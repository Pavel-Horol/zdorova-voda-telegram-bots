import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Тонкая обёртка над сгенерированным PrismaClient.
 * Подключается при старте модуля и закрывает соединение при остановке.
 * Доступ к данным из сервисов — через репозитории/методы модулей (см. CLAUDE.md §6).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
