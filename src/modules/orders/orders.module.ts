import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ClientsModule } from '../clients/clients.module';
import { PricingModule } from '../pricing/pricing.module';
import { PricingSettingsModule } from '../pricing-settings/pricing-settings.module';
import {
  ORDER_DISPATCHER,
  NoopOrderDispatcher,
} from '../../bots/shared/order-dispatcher';

@Module({
  imports: [ClientsModule, PricingModule, PricingSettingsModule],
  providers: [
    OrdersService,
    // MVP-заглушка. В задаче про ботов заменим на отправку в диспетчерский бот.
    { provide: ORDER_DISPATCHER, useClass: NoopOrderDispatcher },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
