import { Module } from '@nestjs/common';
import { ClientsModule } from '../../modules/clients/clients.module';
import { OrdersModule } from '../../modules/orders/orders.module';
import { PricingSettingsModule } from '../../modules/pricing-settings/pricing-settings.module';
import { ContactsModule } from '../../modules/contacts/contacts.module';
import { ClientBotService } from './client-bot.service';

/**
 * Client bot (SPEC §6). Takes data via the clients/orders/pricing-settings/contacts
 * module services — the bot has no direct Prisma access (CLAUDE.md §6). pricing-settings
 * feeds "Prices"; contacts feeds "Зв'язатися" (dispatcher-managed phones).
 */
@Module({
  imports: [ClientsModule, OrdersModule, PricingSettingsModule, ContactsModule],
  providers: [ClientBotService],
})
export class ClientBotModule {}
