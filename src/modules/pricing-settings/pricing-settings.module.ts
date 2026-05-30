import { Module } from '@nestjs/common';
import { PricingSettingsService } from './pricing-settings.service';

@Module({
  providers: [PricingSettingsService],
  exports: [PricingSettingsService],
})
export class PricingSettingsModule {}
