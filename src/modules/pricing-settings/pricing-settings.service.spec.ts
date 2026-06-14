import type { PrismaService } from '../../prisma/prisma.service';
import type { PriceSettings } from '../../../generated/prisma/client';
import { PricingSettingsService } from './pricing-settings.service';

// PrismaService тянет сгенерированный клиент Prisma 7 (ESM, import.meta), который
// ts-jest не компилирует под CommonJS. В юнит-тесте клиент не нужен — мокаем модуль,
// чтобы реальный импорт не выполнялся; Prisma инжектим собственным мок-объектом.
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
    it('читает строку-синглтон по id=1', async () => {
      prisma.priceSettings.findUniqueOrThrow.mockResolvedValue(row);

      await expect(service.getCurrent()).resolves.toEqual(row);
      expect(prisma.priceSettings.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });
  });

  describe('update', () => {
    it('обновляет одно поле в строке id=1', async () => {
      const updated = { ...row, price1: 90 };
      prisma.priceSettings.update.mockResolvedValue(updated);

      await expect(service.update('price1', 90)).resolves.toEqual(updated);
      expect(prisma.priceSettings.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { price1: 90 },
      });
    });

    it('бросает ошибку на отрицательное значение и не пишет в БД', () => {
      expect(() => service.update('pumpPrice', -5)).toThrow();
      expect(prisma.priceSettings.update).not.toHaveBeenCalled();
    });
  });
});
