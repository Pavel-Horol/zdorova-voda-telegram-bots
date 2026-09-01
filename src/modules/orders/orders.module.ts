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
import { resolveOrderChannel } from '../../config/demo';

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
      // The channel is resolved from env explicitly (see config/demo.ts), not from
      // NODE_ENV alone: the demo stand also has live tokens and MUST reach its
      // dispatcher bot. Read at module-metadata time — main.ts imports config/load-env
      // first, so the env file is already in process.env here.
      useClass:
        resolveOrderChannel(process.env) === 'telegram'
          ? TelegramOrderDispatcher
          : LogOrderDispatcher,
    },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
