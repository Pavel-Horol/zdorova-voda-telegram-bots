import { PricingService, PriceList } from './pricing.service';

// Дефолтные цены (совпадают с сидом PriceSettings, PRODUCT.md).
const prices: PriceList = {
  price1: 80,
  priceFrom2: 70,
  priceFrom6: 65,
  depositPerBottle: 450,
  pumpPrice: 250,
  electroPumpPrice: 270,
  waterStartPrice: 50,
};

describe('PricingService.calculateTotal', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('повторный заказ с достаточной тарой — сетка воды 1 / от 2 / от 6', () => {
    // bottlesOnHand=100 заведомо ≥ заказа → добора нет, чистая сетка.
    it.each([
      [1, 80],
      [2, 140],
      [3, 210],
      [5, 350],
      [6, 390],
      [7, 455],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'REPEAT', prices, 100)).toBe(
        expected,
      );
    });
  });

  describe('повторный заказ — добор тары (вода по сетке на всё + залог за новый бак)', () => {
    it('на руках 1, заказ 2 → 2×70 + 450 = 590', () => {
      expect(service.calculateTotal(2, 'REPEAT', prices, 1)).toBe(590);
    });

    it('на руках 2, заказ 3 → 3×70 + 450 = 660', () => {
      expect(service.calculateTotal(3, 'REPEAT', prices, 2)).toBe(660);
    });

    it('на руках 3, заказ 2 (≤ остатка) → чистая сетка 140, без залога', () => {
      expect(service.calculateTotal(2, 'REPEAT', prices, 3)).toBe(140);
    });

    it('на руках 0, заказ 3 → вода 3×70 + 3×450 = 1560', () => {
      expect(service.calculateTotal(3, 'REPEAT', prices, 0)).toBe(1560);
    });
  });

  describe('newTara — сколько баков под залог', () => {
    it('STARTER_KIT — все баки', () => {
      expect(service.newTara(2, 'STARTER_KIT', 0)).toBe(2);
    });

    it('REPEAT — сверх остатка на руках', () => {
      expect(service.newTara(3, 'REPEAT', 2)).toBe(1);
      expect(service.newTara(2, 'REPEAT', 5)).toBe(0);
    });

    it('OWN_TARA — ноль (тара клиента)', () => {
      expect(service.newTara(4, 'OWN_TARA', 0)).toBe(0);
    });
  });

  describe('первый заказ — стартовый комплект (залог+помпа+старт-вода)', () => {
    it.each([
      [1, 750],
      [2, 1250],
      [3, 1750],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'STARTER_KIT', prices)).toBe(
        expected,
      );
    });
  });

  describe('своя тара (OWN_TARA) — только вода по сетке, залог 0', () => {
    it.each([
      [1, 80],
      [3, 210],
      [6, 390],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'OWN_TARA', prices)).toBe(
        expected,
      );
    });
  });

  describe('опции помпы (T5)', () => {
    it('комплект с электро-помпой: 1 бак → 450 + 270 + 50 = 770', () => {
      expect(
        service.calculateTotal(1, 'STARTER_KIT', prices, 0, { electro: true }),
      ).toBe(770);
    });

    it('комплект обычный (без electro) → 750', () => {
      expect(service.calculateTotal(1, 'STARTER_KIT', prices, 0, {})).toBe(750);
    });

    it('своя тара с докупкой помпы: 2 бака → 2×70 + 250 = 390', () => {
      expect(
        service.calculateTotal(2, 'OWN_TARA', prices, 0, { pumpAddon: true }),
      ).toBe(390);
    });
  });

  describe('edge-кейсы', () => {
    it('бросает ошибку на 0 бутылей', () => {
      expect(() => service.calculateTotal(0, 'REPEAT', prices)).toThrow();
      expect(() => service.calculateTotal(0, 'STARTER_KIT', prices)).toThrow();
    });

    it('бросает ошибку на отрицательное количество', () => {
      expect(() => service.calculateTotal(-1, 'REPEAT', prices)).toThrow();
    });

    it('бросает ошибку на дробное количество', () => {
      expect(() => service.calculateTotal(1.5, 'REPEAT', prices)).toThrow();
    });
  });
});
