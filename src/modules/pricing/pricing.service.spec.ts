import { PricingService, PriceList } from './pricing.service';

// Default prices (match the PriceSettings seed, PRODUCT.md).
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

  describe('repeat order with enough tara — water grid 1 / from 2 / from 6', () => {
    // bottlesOnHand=100 is surely ≥ the order → no top-up, pure grid.
    it.each([
      [1, 80],
      [2, 140],
      [3, 210],
      [5, 350],
      [6, 390],
      [7, 455],
    ])('%i bottle(s) → %i UAH', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'REPEAT', prices, 100)).toBe(
        expected,
      );
    });
  });

  describe('repeat order — tara top-up (water by grid for all + deposit per new bottle)', () => {
    it('1 on hand, order 2 → 2×70 + 450 = 590', () => {
      expect(service.calculateTotal(2, 'REPEAT', prices, 1)).toBe(590);
    });

    it('2 on hand, order 3 → 3×70 + 450 = 660', () => {
      expect(service.calculateTotal(3, 'REPEAT', prices, 2)).toBe(660);
    });

    it('3 on hand, order 2 (≤ remainder) → pure grid 140, no deposit', () => {
      expect(service.calculateTotal(2, 'REPEAT', prices, 3)).toBe(140);
    });

    it('0 on hand, order 3 → water 3×70 + 3×450 = 1560', () => {
      expect(service.calculateTotal(3, 'REPEAT', prices, 0)).toBe(1560);
    });
  });

  describe('newTara — how many bottles under deposit', () => {
    it('STARTER_KIT — all bottles', () => {
      expect(service.newTara(2, 'STARTER_KIT', 0)).toBe(2);
    });

    it('REPEAT — above the remainder on hand', () => {
      expect(service.newTara(3, 'REPEAT', 2)).toBe(1);
      expect(service.newTara(2, 'REPEAT', 5)).toBe(0);
    });

    it('OWN_TARA — above the declared on-hand (tara top-up), same as REPEAT', () => {
      expect(service.newTara(4, 'OWN_TARA', 3)).toBe(1); // order 4, has 3 → 1 new bottle
      expect(service.newTara(3, 'OWN_TARA', 3)).toBe(0); // exact exchange → none
      expect(service.newTara(2, 'OWN_TARA', 5)).toBe(0); // fewer than on hand → none
    });
  });

  describe('first order — starter kit (deposit+pump+starter water)', () => {
    it.each([
      [1, 750],
      [2, 1250],
      [3, 1750],
    ])('%i bottle(s) → %i UAH', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'STARTER_KIT', prices)).toBe(
        expected,
      );
    });
  });

  describe('own bottles (OWN_TARA) — exchange at grid (deposit 0), top-up under deposit', () => {
    // Has at least as many own bottles as ordered → pure exchange, no deposit.
    it.each([
      [1, 80],
      [3, 210],
      [6, 390],
    ])('%i bottle(s) with enough own tara → %i UAH', (bottles, expected) => {
      expect(service.calculateTotal(bottles, 'OWN_TARA', prices, bottles)).toBe(
        expected,
      );
    });

    it('ordered above the on-hand → deposit on the extra (3 on hand, order 4 → 4×70 + 450 = 730)', () => {
      expect(service.calculateTotal(4, 'OWN_TARA', prices, 3)).toBe(730);
    });

    it('ordered exactly the on-hand → no top-up (3 on hand, order 3 → 210)', () => {
      expect(service.calculateTotal(3, 'OWN_TARA', prices, 3)).toBe(210);
    });
  });

  describe('pump options (T5)', () => {
    it('kit with an electric pump: 1 bottle → 450 + 270 + 50 = 770', () => {
      expect(
        service.calculateTotal(1, 'STARTER_KIT', prices, 0, { electro: true }),
      ).toBe(770);
    });

    it('standard kit (without electro) → 750', () => {
      expect(service.calculateTotal(1, 'STARTER_KIT', prices, 0, {})).toBe(750);
    });

    it('own bottles with a pump add-on: 2 bottles, 2 on hand → 2×70 + 250 = 390', () => {
      expect(
        service.calculateTotal(2, 'OWN_TARA', prices, 2, { pumpAddon: true }),
      ).toBe(390);
    });
  });

  describe('waterUnitPrice — grid tier boundaries', () => {
    it('1 → price1, 2..5 → priceFrom2, ≥6 → priceFrom6', () => {
      expect(service.waterUnitPrice(1, prices)).toBe(80);
      expect(service.waterUnitPrice(2, prices)).toBe(70);
      expect(service.waterUnitPrice(5, prices)).toBe(70);
      expect(service.waterUnitPrice(6, prices)).toBe(65); // boundary: 6 is the from-6 tier
      expect(service.waterUnitPrice(10, prices)).toBe(65);
    });
  });

  describe('edge cases', () => {
    it('throws on 0 bottles', () => {
      expect(() => service.calculateTotal(0, 'REPEAT', prices)).toThrow();
      expect(() => service.calculateTotal(0, 'STARTER_KIT', prices)).toThrow();
    });

    it('throws on a negative quantity', () => {
      expect(() => service.calculateTotal(-1, 'REPEAT', prices)).toThrow();
    });

    it('throws on a fractional quantity', () => {
      expect(() => service.calculateTotal(1.5, 'REPEAT', prices)).toThrow();
    });

    it('throws on an unknown order kind (defensive default branch)', () => {
      expect(() =>
        service.calculateTotal(1, 'BOGUS' as unknown as 'REPEAT', prices),
      ).toThrow(/unknown order kind/);
    });

    it('newTara returns 0 for an unknown kind (defensive default branch)', () => {
      expect(service.newTara(3, 'BOGUS' as unknown as 'REPEAT', 0)).toBe(0);
    });

    it('OWN_TARA with bottlesOnHand defaulting to 0 → the whole order is new tara', () => {
      // default bottlesOnHand=0: order of 2 own-tara bottles is all under deposit.
      expect(service.calculateTotal(2, 'OWN_TARA', prices)).toBe(
        2 * 70 + 2 * 450,
      );
    });
  });
});
