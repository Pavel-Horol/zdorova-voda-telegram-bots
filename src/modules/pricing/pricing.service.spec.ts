import { PricingService, PriceList } from './pricing.service';

// Дефолтные цены (совпадают с сидом PriceSettings, PRODUCT.md).
const prices: PriceList = {
  price1: 80,
  priceFrom2: 70,
  priceFrom6: 65,
  depositPerBottle: 450,
  pumpPrice: 250,
  waterStartPrice: 50,
};

describe('PricingService.calculateTotal', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('повторный заказ — сетка воды 1 / от 2 / от 6', () => {
    it.each([
      [1, 80],
      [2, 140],
      [3, 210],
      [5, 350],
      [6, 390],
      [7, 455],
    ])('%i бутыл(ей) → %i грн', (bottles, expected) => {
      expect(service.calculateTotal(bottles, false, prices)).toBe(expected);
    });
  });

  describe('первый заказ — стартовый комплект (залог+помпа+старт-вода)', () => {
    it.each([
      [1, 750],
      [2, 1250],
      [3, 1750],
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
