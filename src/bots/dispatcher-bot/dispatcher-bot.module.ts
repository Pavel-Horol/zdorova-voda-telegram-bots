import { Module } from '@nestjs/common';
import { OrdersModule } from '../../modules/orders/orders.module';
import { PricingSettingsModule } from '../../modules/pricing-settings/pricing-settings.module';
import { DispatcherBotCoreModule } from './dispatcher-bot-core.module';
import { DispatcherBotService } from './dispatcher-bot.service';

/**
 * Dispatcher bot (SPEC §7). Takes the shared instance from DispatcherBotCoreModule
 * (the same one that sends notifications); business operations — via OrdersService
 * and PricingSettingsService. The bot has no direct Prisma access (CLAUDE.md §6).
 */
@Module({
  imports: [DispatcherBotCoreModule, OrdersModule, PricingSettingsModule],
  providers: [DispatcherBotService],
})
export class DispatcherBotModule {}
