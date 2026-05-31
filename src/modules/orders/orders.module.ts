import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ClientsModule } from '../clients/clients.module';
import { PricingModule } from '../pricing/pricing.module';
import { PricingSettingsModule } from '../pricing-settings/pricing-settings.module';
import {
  ORDER_DISPATCHER,
  LogOrderDispatcher,
  TelegramOrderDispatcher,
} from '../../bots/shared/order-dispatcher';

@Module({
  imports: [ClientsModule, PricingModule, PricingSettingsModule],
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
