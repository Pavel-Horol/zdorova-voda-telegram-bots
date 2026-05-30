import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { PriceSettings } from '../../../generated/prisma/client';

const PRICE_SETTINGS_ID = 1;

export type EditablePriceField =
  | 'price1'
  | 'price2'
  | 'price3plus'
  | 'depositPerBottle'
  | 'pumpPrice';

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
}
