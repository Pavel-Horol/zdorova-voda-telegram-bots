import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ClientsModule } from '../clients/clients.module';
import { PricingModule } from '../pricing/pricing.module';
import { PricingSettingsModule } from '../pricing-settings/pricing-settings.module';
import { DispatchersModule } from '../dispatchers/dispatchers.module';
import {
  ORDER_DISPATCHER,
  LogOrderDispatcher,
} from '../../bots/shared/order-dispatcher';
import { TelegramOrderDispatcher } from '../../bots/dispatcher-bot/telegram-order-dispatcher';
import { DispatcherBotCoreModule } from '../../bots/dispatcher-bot/dispatcher-bot-core.module';

@Module({
  imports: [
    ClientsModule,
    PricingModule,
    PricingSettingsModule,
    DispatchersModule,
    DispatcherBotCoreModule,
  ],
  providers: [
    OrdersService,
    {
      provide: ORDER_DISPATCHER,
      useClass:
        process.env.NODE_ENV === 'production'
          ? TelegramOrderDispatcher
          : LogOrderDispatcher,
    },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
