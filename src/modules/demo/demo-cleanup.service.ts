import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientsService } from '../clients/clients.service';
import { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import { DemoShowcaseService } from './demo-showcase.service';
import {
  DEMO_VISITOR_PHONE_PREFIX,
  demoCleanupIntervalMs,
  demoTtlHours,
} from '../../config/demo';

/**
 * Keeps the demo stand presentable for the NEXT buyer: periodically deletes stale
 * visitor data (their client row, addresses and orders go by cascade), restores the
 * price grid that a visitor may have edited, and re-creates the showcase history if it
 * is somehow gone.
 *
 * Only rows with the visitor phone prefix are deleted — the showcase carries a
 * different one and survives. A plain `setInterval` rather than @nestjs/schedule: one
 * timer does not justify a dependency, and the stand is the only thing that needs it.
 *
 * The first pass runs after one interval, not at boot — the showcase seeding of
 * {@link DemoShowcaseService} is still running then, and the two must not race.
 */
@Injectable()
export class DemoCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly clients: ClientsService,
    private readonly pricingSettings: PricingSettingsService,
    private readonly showcase: DemoShowcaseService,
  ) {}

  onModuleInit(): void {
    const intervalMs = demoCleanupIntervalMs(process.env);
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    // Never keep the process alive for the sweep.
    this.timer.unref();
    this.logger.log(
      `demo cleanup every ${Math.round(intervalMs / 60000)} min, ` +
        `visitor data TTL ${demoTtlHours(process.env)} h`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass. Swallows its own errors: the sweep is background housekeeping and must
   * never take the stand down (same contract as the event listeners, CLAUDE.md rule 10).
   */
  async sweep(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - demoTtlHours(process.env) * 60 * 60 * 1000,
      );
      const removed = await this.clients.deleteDemoVisitors(
        DEMO_VISITOR_PHONE_PREFIX,
        cutoff,
      );
      await this.pricingSettings.resetToDefaults();
      await this.showcase.ensure();
      if (removed > 0) {
        this.logger.log(`demo cleanup: removed ${removed} visitor(s)`);
      }
    } catch (err) {
      this.logger.warn(`demo cleanup failed: ${(err as Error).message}`);
    }
  }
}
