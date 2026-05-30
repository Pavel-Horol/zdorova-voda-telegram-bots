import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Тонкая обёртка над сгенерированным PrismaClient.
 * Prisma 7: подключение к Postgres идёт через driver adapter (@prisma/adapter-pg),
 * строка подключения берётся из DATABASE_URL. Подключается при старте модуля и
 * закрывает соединение при остановке. Доступ к данным из сервисов — через
 * репозитории/методы модулей (см. CLAUDE.md §6).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
