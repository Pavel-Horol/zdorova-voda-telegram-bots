import type { PrismaService } from '../../prisma/prisma.service';
import type { PriceSettings } from '../../../generated/prisma/client';
import { PricingSettingsService } from './pricing-settings.service';

// PrismaService pulls the generated Prisma 7 client (ESM, import.meta), which
// ts-jest does not compile under CommonJS. The client is not needed in the unit test — mock the
// module so the real import does not run; Prisma is injected via our own mock object.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const row: PriceSettings = {
  id: 1,
  price1: 80,
  priceFrom2: 70,
  priceFrom6: 65,
  depositPerBottle: 450,
  pumpPrice: 250,
  electroPumpPrice: 270,
  waterStartPrice: 50,
  updatedAt: new Date('2026-05-30T00:00:00.000Z'),
};

describe('PricingSettingsService', () => {
  let service: PricingSettingsService;
  let prisma: {
    priceSettings: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      priceSettings: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new PricingSettingsService(prisma as unknown as PrismaService);
  });

  describe('getCurrent', () => {
    it('reads the singleton row by id=1', async () => {
      prisma.priceSettings.findUniqueOrThrow.mockResolvedValue(row);

      await expect(service.getCurrent()).resolves.toEqual(row);
      expect(prisma.priceSettings.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });
  });

  describe('update', () => {
    it('updates a single field in the id=1 row', async () => {
      const updated = { ...row, price1: 90 };
      prisma.priceSettings.update.mockResolvedValue(updated);

      await expect(service.update('price1', 90)).resolves.toEqual(updated);
      expect(prisma.priceSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { price1: 90 },
      });
    });

    it('throws on a negative value and does not write to the DB', () => {
      expect(() => service.update('pumpPrice', -5)).toThrow();
      expect(prisma.priceSettings.update).not.toHaveBeenCalled();
    });
  });
});
