import { Module } from '@nestjs/common';
import { ClientsModule } from '../../modules/clients/clients.module';
import { OrdersModule } from '../../modules/orders/orders.module';
import { ClientBotService } from './client-bot.service';

/**
 * Клиентский бот (SPEC §6). Данные берёт через сервисы модулей clients/orders —
 * прямого доступа к Prisma у бота нет (CLAUDE.md §6).
 */
@Module({
  imports: [ClientsModule, OrdersModule],
  providers: [ClientBotService],
})
export class ClientBotModule {}
