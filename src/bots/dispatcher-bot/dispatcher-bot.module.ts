import { Module } from '@nestjs/common';
import { ClientsModule } from '../../modules/clients/clients.module';
import { OrdersModule } from '../../modules/orders/orders.module';
import { PricingSettingsModule } from '../../modules/pricing-settings/pricing-settings.module';
import { ContactsModule } from '../../modules/contacts/contacts.module';
import { DispatchersModule } from '../../modules/dispatchers/dispatchers.module';
import { DispatcherBotCoreModule } from './dispatcher-bot-core.module';
import { DispatcherBotService } from './dispatcher-bot.service';

/**
 * Dispatcher bot (SPEC §7). Takes the shared instance from DispatcherBotCoreModule
 * (the same one that sends notifications); business operations — via OrdersService,
 * PricingSettingsService, ContactsService (support phones) and ClientsService (lookup).
 * No direct Prisma (§6).
 */
@Module({
  imports: [
    DispatcherBotCoreModule,
    OrdersModule,
    PricingSettingsModule,
    ContactsModule,
    ClientsModule,
    DispatchersModule,
  ],
  providers: [DispatcherBotService],
})
export class DispatcherBotModule {}
