import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * A thin wrapper over the generated PrismaClient.
 * Prisma 7: the Postgres connection goes through a driver adapter (@prisma/adapter-pg),
 * the connection string is taken from DATABASE_URL. Connects on module start and
 * closes the connection on stop. Data access from services — via the module
 * repositories/methods (see CLAUDE.md §6).
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
