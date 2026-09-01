import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module';
import { OrdersModule } from '../orders/orders.module';
import { PricingModule } from '../pricing/pricing.module';
import { PricingSettingsModule } from '../pricing-settings/pricing-settings.module';
import { DemoAutoDispatcherService } from './demo-auto-dispatcher.service';
import { DemoCleanupService } from './demo-cleanup.service';
import { DemoShowcaseService } from './demo-showcase.service';

/**
 * Everything the demo stand adds on top of the normal bot: a simulated dispatcher, a
 * showcase history and a periodic cleanup. Registered by AppModule ONLY when
 * DEMO_MODE is on — with the flag off none of this is even instantiated, so the live
 * product cannot accidentally auto-accept an order or delete a client.
 *
 * The client-facing demo behaviour (no phone asked, `/reset`, the banner) lives in the
 * bots themselves — it is a different screen, not a background job.
 */
@Module({
  imports: [OrdersModule, ClientsModule, PricingModule, PricingSettingsModule],
  providers: [
    DemoAutoDispatcherService,
    DemoShowcaseService,
    DemoCleanupService,
  ],
})
export class DemoModule {}
