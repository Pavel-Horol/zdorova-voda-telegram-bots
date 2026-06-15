import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global DB access module.
 * PrismaService is exported once and available in all modules
 * without re-importing PrismaModule.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
