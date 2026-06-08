import { Module } from '@nestjs/common';
import { ClientsModule } from '../../modules/clients/clients.module';
import { OrdersModule } from '../../modules/orders/orders.module';
import { PricingSettingsModule } from '../../modules/pricing-settings/pricing-settings.module';
import { ClientBotService } from './client-bot.service';

/**
 * Клиентский бот (SPEC §6). Данные берёт через сервисы модулей
 * clients/orders/pricing-settings — прямого доступа к Prisma у бота нет
 * (CLAUDE.md §6). pricing-settings нужен для экрана «Цены».
 */
@Module({
  imports: [ClientsModule, OrdersModule, PricingSettingsModule],
  providers: [ClientBotService],
})
export class ClientBotModule {}
