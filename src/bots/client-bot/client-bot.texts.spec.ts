import { OrderKind, OrderStatus } from '../../../generated/prisma/enums';
import type {
  Order,
  Address,
  PriceSettings,
} from '../../../generated/prisma/client';
import type { OrderQuote } from '../../modules/orders/orders.service';
import { texts } from './client-bot.texts';

const prices: PriceSettings = {
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

function makeQuote(over: Partial<OrderQuote> = {}): OrderQuote {
  return {
    kind: OrderKind.REPEAT,
    bottles: 2,
    totalPrice: 140,
    perBottle: 70,
    newTara: 0,
    depositPerBottle: 450,
    pumpPrice: 250,
    electroPumpPrice: 270,
    waterStartPrice: 50,
    electro: false,
    pumpAddon: false,
    ...over,
  };
}

function makeAddress(over: Partial<Address> = {}): Address {
  return { raw: 'St. 1', comment: null, ...over } as Address;
}

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    bottles: 2,
    totalPrice: 140,
    status: OrderStatus.CREATED,
    // Fixed local date so shortDate is deterministic regardless of the machine TZ.
    createdAt: new Date(2026, 6, 1, 12, 0, 0), // 01.07
    ...over,
  } as Order;
}

describe('client-bot texts', () => {
  describe('mainMenu', () => {
    it('greets a known client by name', () => {
      expect(texts.mainMenu('Іван')).toBe(
        'З поверненням, Іван! 👋\nЧим допоможемо?',
      );
    });

    it('falls back to a nameless greeting', () => {
      expect(texts.mainMenu(null)).toBe('З поверненням! 👋\nЧим допоможемо?');
    });
  });

  describe('repeatButton — Ukrainian plural of "бутель"', () => {
    it.each([
      [1, '1 бутель'],
      [2, '2 бутлі'],
      [3, '3 бутлі'],
      [4, '4 бутлі'],
      [5, '5 бутлів'],
      [11, '11 бутлів'], // 11 is an exception → бутлів, not бутель
      [12, '12 бутлів'],
      [14, '14 бутлів'],
      [21, '21 бутель'],
      [22, '22 бутлі'],
      [100, '100 бутлів'],
    ])('%i → "%s"', (n, expected) => {
      expect(texts.repeatButton(n)).toBe(`🔄 Повторити: ${expected}`);
    });
  });

  describe('confirm — price breakdown by kind', () => {
    it('STARTER_KIT (std pump): deposit + pump + starter water, per-bottle omitted', () => {
      const q = makeQuote({
        kind: OrderKind.STARTER_KIT,
        bottles: 1,
        totalPrice: 750,
        perBottle: null,
        newTara: 1,
      });
      expect(texts.confirm(q, makeAddress())).toBe(
        'Хочу замовити:\n' +
          '📦 1 бутель (стартовий комплект: застава 1×450 + помпа 250 + вода 1×50)\n' +
          '📍 St. 1\n' +
          '💰 До сплати: 750 грн (готівкою водієві)',
      );
    });

    it('STARTER_KIT with an electric pump shows the electro line and price', () => {
      const q = makeQuote({
        kind: OrderKind.STARTER_KIT,
        bottles: 2,
        totalPrice: 1290,
        perBottle: null,
        newTara: 2,
        electro: true,
      });
      expect(texts.confirm(q, makeAddress())).toContain(
        'стартовий комплект: застава 2×450 + електро-помпа 270 + вода 2×50',
      );
    });

    it('REPEAT with a tara top-up: water by grid + new-bottle deposit line', () => {
      const q = makeQuote({ bottles: 2, totalPrice: 590, newTara: 1 });
      expect(texts.confirm(q, makeAddress())).toContain(
        '📦 2 бутлі (вода 2×70 + 1 нов. бак ×450 застава)',
      );
    });

    it('REPEAT with enough tara: plain per-bottle price', () => {
      const q = makeQuote({ bottles: 2, totalPrice: 140, newTara: 0 });
      expect(texts.confirm(q, makeAddress())).toContain(
        '📦 2 бутлі (по 70 грн)',
      );
    });

    it('OWN_TARA with a pump add-on appends the pump price', () => {
      const q = makeQuote({
        kind: OrderKind.OWN_TARA,
        bottles: 2,
        totalPrice: 390,
        newTara: 0,
        pumpAddon: true,
      });
      expect(texts.confirm(q, makeAddress())).toContain(
        '📦 2 бутлі (по 70 грн + помпа 250)',
      );
    });

    it('renders the address comment in parentheses when present', () => {
      const q = makeQuote();
      expect(
        texts.confirm(q, makeAddress({ comment: 'домофон 45' })),
      ).toContain('📍 St. 1 (домофон 45)');
    });

    it('renders the order note on its own line when provided', () => {
      const q = makeQuote();
      const out = texts.confirm(q, makeAddress(), 'мене не буде з 14 до 16');
      expect(out).toContain('📝 мене не буде з 14 до 16');
    });

    it('omits the note line when there is no order note', () => {
      const q = makeQuote();
      expect(texts.confirm(q, makeAddress())).not.toContain('📝');
    });

    it('falls back to 0 when perBottle is unexpectedly null on a water order', () => {
      // Defensive: perBottle ?? 0 — a water order should always carry perBottle,
      // but a null must not render "undefined".
      const q = makeQuote({ perBottle: null, newTara: 0 });
      expect(texts.confirm(q, makeAddress())).toContain('(по 0 грн)');
    });
  });

  describe('orderStatusUpdate — client-facing status notifications', () => {
    it('ACCEPTED / DELIVERED / CANCELLED have messages', () => {
      expect(
        texts.orderStatusUpdate(makeOrder({ status: OrderStatus.ACCEPTED })),
      ).toBe('Ваше замовлення прийнято ✅ Готуємо до доставки.');
      expect(
        texts.orderStatusUpdate(makeOrder({ status: OrderStatus.DELIVERED })),
      ).toBe('Замовлення доставлено 🚚 Дякуємо, що обрали нас!');
      expect(
        texts.orderStatusUpdate(makeOrder({ status: OrderStatus.CANCELLED })),
      ).toBe('Ваше замовлення скасовано. Якщо це помилка — зв’яжіться з нами.');
    });

    it('CREATED returns null — the initial status is not pushed to the client', () => {
      expect(
        texts.orderStatusUpdate(makeOrder({ status: OrderStatus.CREATED })),
      ).toBeNull();
    });
  });

  describe('orderEdited — dispatcher edited the order', () => {
    it('shows the current quantity (plural) and total', () => {
      expect(
        texts.orderEdited(makeOrder({ bottles: 3, totalPrice: 210 })),
      ).toBe(
        'Ваше замовлення оновлено диспетчером 📝\nЗараз: 3 бутлі, сума 210 грн.',
      );
    });
  });

  describe('deliveryNoteUpdate — dispatcher delivery-timing message', () => {
    it('wraps the dispatcher phrase', () => {
      expect(
        texts.deliveryNoteUpdate(makeOrder({ deliveryNote: 'сьогодні' })),
      ).toBe('🕒 Час доставки вашого замовлення: сьогодні');
    });

    it('returns null for a blank/absent note', () => {
      expect(
        texts.deliveryNoteUpdate(makeOrder({ deliveryNote: null })),
      ).toBeNull();
      expect(
        texts.deliveryNoteUpdate(makeOrder({ deliveryNote: '  ' })),
      ).toBeNull();
    });
  });

  describe('history', () => {
    it('lists orders with short date, plural, price and status label', () => {
      const out = texts.history([
        makeOrder({ bottles: 2, totalPrice: 140, status: OrderStatus.CREATED }),
        makeOrder({
          bottles: 1,
          totalPrice: 80,
          status: OrderStatus.DELIVERED,
        }),
      ]);
      expect(out).toBe(
        '📋 Ваші останні замовлення:\n' +
          '• 01.07 — 2 бутлі, 140 грн — 🆕 прийнято\n' +
          '• 01.07 — 1 бутель, 80 грн — 🚚 доставлено',
      );
    });

    it('has a dedicated empty message', () => {
      expect(texts.historyEmpty).toContain('поки немає замовлень');
    });
  });

  describe('addressView', () => {
    it('shows the comment on its own line when present', () => {
      expect(
        texts.addressView(makeAddress({ raw: 'St. 5', comment: 'floor 3' })),
      ).toBe('📍 Ваша адреса доставки:\nSt. 5\n📝 floor 3');
    });

    it('omits the comment line when absent', () => {
      expect(texts.addressView(makeAddress({ raw: 'St. 5' }))).toBe(
        '📍 Ваша адреса доставки:\nSt. 5',
      );
    });
  });

  describe('parametric texts include their data', () => {
    it('pumpChoice lists deposit, starter water and both pump prices', () => {
      const out = texts.pumpChoice(prices);
      expect(out).toContain('застава 450 грн');
      expect(out).toContain('перша вода — 50 грн/бак');
      expect(out).toContain('Звичайна — 250 грн');
      expect(out).toContain('Електрична — 270 грн');
    });

    it('ownPumpAsk shows the add-on pump price', () => {
      expect(texts.ownPumpAsk(250)).toContain('250 грн');
    });

    it('onboardingToDispatcher and contacts surface the support phone', () => {
      expect(texts.onboardingToDispatcher('+380123')).toContain('+380123');
      expect(texts.contacts('+380123')).toContain('+380123');
    });

    it('prices lists the water grid and the starter-kit line', () => {
      const out = texts.prices(prices);
      expect(out).toContain('1 бутель — 80 грн');
      expect(out).toContain('від 2 — 70 грн/шт');
      expect(out).toContain('від 6 — 65 грн/шт');
      expect(out).toContain('застава 450 грн/бак');
    });
  });
});
