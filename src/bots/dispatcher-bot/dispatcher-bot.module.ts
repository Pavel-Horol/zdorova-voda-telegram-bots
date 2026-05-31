import { Module } from '@nestjs/common';
import { OrdersModule } from '../../modules/orders/orders.module';
import { PricingSettingsModule } from '../../modules/pricing-settings/pricing-settings.module';
import { DispatcherBotCoreModule } from './dispatcher-bot-core.module';
import { DispatcherBotService } from './dispatcher-bot.service';

/**
 * Диспетчерский бот (SPEC §7). Общий инстанс берёт из DispatcherBotCoreModule
 * (тот же, что шлёт уведомления), бизнес-операции — через OrdersService и
 * PricingSettingsService. Прямого доступа к Prisma у бота нет (CLAUDE.md §6).
 */
@Module({
  imports: [DispatcherBotCoreModule, OrdersModule, PricingSettingsModule],
  providers: [DispatcherBotService],
})
export class DispatcherBotModule {}
