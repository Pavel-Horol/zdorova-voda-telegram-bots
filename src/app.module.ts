import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { PricingSettingsModule } from './modules/pricing-settings/pricing-settings.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { ClientsModule } from './modules/clients/clients.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ClientBotModule } from './bots/client-bot/client-bot.module';
import { DispatcherBotModule } from './bots/dispatcher-bot/dispatcher-bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    PricingModule,
    PricingSettingsModule,
    ContactsModule,
    ClientsModule,
    OrdersModule,
    ClientBotModule,
    DispatcherBotModule,
  ],
})
export class AppModule {}
