import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { DispatchersModule } from '../dispatchers/dispatchers.module';
import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { PricingSettingsModule } from '../pricing-settings/pricing-settings.module';
import { DemoAutoDispatcherService } from './demo-auto-dispatcher.service';
import { DemoCleanupService } from './demo-cleanup.service';
import { DemoOrderFeedService } from './demo-order-feed.service';
import { DemoShowcaseService } from './demo-showcase.service';

/**
 * Everything the demo stand adds on top of the normal bot: a simulated dispatcher, a
 * showcase history, a feed of invented orders and a periodic cleanup. Registered by
 * AppModule ONLY when DEMO_MODE is on — with the flag off none of this is even instantiated, so the live
 * product cannot accidentally auto-accept an order or delete a client.
 *
 * The client-facing demo behaviour (no phone asked, `/reset`, the banner) lives in the
 * bots themselves — it is a different screen, not a background job.
 */
@Module({
  imports: [
    OrdersModule,
    ClientsModule,
    PricingModule,
    PricingSettingsModule,
    DispatchersModule,
  ],
  providers: [
    DemoAutoDispatcherService,
    DemoShowcaseService,
    DemoCleanupService,
    DemoOrderFeedService,
  ],
})
export class DemoModule {}
