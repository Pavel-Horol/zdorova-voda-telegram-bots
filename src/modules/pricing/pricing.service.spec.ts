import { PricingService, PriceList } from './pricing.service';

// Дефолтные цены (совпадают с сидом PriceSettings, SPEC §3).
const prices: PriceList = {
  price1: 80,
  price2: 75,
  price3plus: 70,
  depositPerBottle: 300,
  pumpPrice: 200,
};

describe('PricingService.calculateTotal', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('повторный заказ (SPEC §3.1)', () => {
    it.each([
      [1, 80],
      [2, 150],
      [3, 210],
      [5, 350],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, false, prices)).toBe(expected);
    });
  });

  describe('первый заказ (SPEC §3.2)', () => {
    it.each([
      [1, 500],
      [2, 800],
      [3, 1100],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, true, prices)).toBe(expected);
    });
  });

  describe('edge-кейсы', () => {
    it('бросает ошибку на 0 бутылей', () => {
      expect(() => service.calculateTotal(0, false, prices)).toThrow();
      expect(() => service.calculateTotal(0, true, prices)).toThrow();
    });

    it('бросает ошибку на отрицательное количество', () => {
      expect(() => service.calculateTotal(-1, false, prices)).toThrow();
    });

    it('бросает ошибку на дробное количество', () => {
      expect(() => service.calculateTotal(1.5, false, prices)).toThrow();
    });
  });
});
