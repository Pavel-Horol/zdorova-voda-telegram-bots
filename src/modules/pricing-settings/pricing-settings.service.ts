import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_PRICE_SETTINGS } from './price-defaults';
import type { PriceSettings } from '../../../generated/prisma/client';

const PRICE_SETTINGS_ID = 1;

export type EditablePriceField =
  | 'price1'
  | 'priceFrom2'
  | 'priceFrom6'
  | 'depositPerBottle'
  | 'pumpPrice'
  | 'electroPumpPrice'
  | 'waterStartPrice';

@Injectable()
export class PricingSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  getCurrent(): Promise<PriceSettings> {
    return this.prisma.priceSettings.findUniqueOrThrow({
      where: { id: PRICE_SETTINGS_ID },
    });
  }

  update(field: EditablePriceField, value: number): Promise<PriceSettings> {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `price value must be a non-negative integer, got: ${value}`,
      );
    }

    return this.prisma.priceSettings.update({
      where: { id: PRICE_SETTINGS_ID },
      data: { [field]: value },
    });
  }

  /**
   * Restores the whole grid to {@link DEFAULT_PRICE_SETTINGS}. Only the demo stand
   * calls this (its periodic sweep): visitors are free to play with prices there, and
   * the next sweep puts the showcase back. Never wire this into the live product —
   * a dispatcher's prices are theirs to keep. Upsert, so a stand whose row is missing
   * heals itself instead of throwing.
   */
  resetToDefaults(): Promise<PriceSettings> {
    return this.prisma.priceSettings.upsert({
      where: { id: PRICE_SETTINGS_ID },
      update: { ...DEFAULT_PRICE_SETTINGS },
      create: { id: PRICE_SETTINGS_ID, ...DEFAULT_PRICE_SETTINGS },
    });
  }
}
