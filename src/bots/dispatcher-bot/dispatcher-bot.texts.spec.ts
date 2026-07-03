import type {
  Order,
  Client,
  Address,
  PriceSettings,
  ContactPhone,
} from '../../../generated/prisma/client';
import { OrderKind, OrderStatus } from '../../../generated/prisma/enums';
import {
  activeOrdersCappedNote,
  activeOrdersHeader,
  activeOrdersSummary,
  cancelReasonCustomPrompt,
  cancelReasonPreset,
  confirmCancelKeyboard,
  contactsKeyboard,
  contactsListMessage,
  callbackRequestMessage,
  clientCancelledMessage,
  clientCardMessage,
  deliveryEtaKeyboard,
  deliveryEtaPreset,
  driverLine,
  editAddressPrompt,
  editClaimPrompt,
  editCommentPrompt,
  editMenuKeyboard,
  editMenuPrompt,
  editQuantityPrompt,
  geoTagPrompt,
  orderKeyboard,
  orderMessage,
  priceFieldLabel,
  pricesMessage,
  statsMessage,
} from './dispatcher-bot.texts';
import type { QueueOrder, QueueSummary } from './dispatcher-bot.fsm';

// Minimal shapes — driverLine only reads the fields below.
function makeOrder(over: Partial<Order> = {}): Order {
  return {
    bottles: 2,
    kind: 'REPEAT',
    newTara: 0,
    electro: false,
    pumpAddon: false,
    totalPrice: 280,
    ...over,
  } as Order;
}
function makeClient(name: string | null = 'Іван'): Client {
  return { name } as Client;
}
function makeAddress(over: Partial<Address> = {}): Address {
  return {
    raw: 'Хмельницького 2 кв5',
    comment: 'домофон 45',
    lat: null,
    lng: null,
    ...over,
  } as Address;
}

// Fuller shapes for the card/message formatters.
function makeCardOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'abcd1234ef',
    bottles: 2,
    kind: OrderKind.REPEAT,
    newTara: 0,
    electro: false,
    pumpAddon: false,
    claimedOnHand: null,
    totalPrice: 280,
    status: OrderStatus.CREATED,
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    ...over,
  } as Order;
}
function makeCardClient(over: Partial<Client> = {}): Client {
  return {
    name: 'Іван',
    phone: '+380501234567',
    bottlesOnHand: 5,
    hasPump: true,
    pendingReview: false,
    ...over,
  } as Client;
}
const cardPrices: PriceSettings = {
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

describe('driverLine', () => {
  it('repeat water order: "Nпо{unit} = {total}" + address + name', () => {
    const line = driverLine(makeOrder(), makeClient(), makeAddress(), 70);
    expect(line).toBe(
      '2по70 = 280 грн\n📍 Хмельницького 2 кв5 (домофон 45)\n👤 Іван',
    );
  });

  it('own-tara with a tara top-up shows the new-bottle count under deposit', () => {
    const order = makeOrder({
      kind: 'OWN_TARA',
      bottles: 4,
      newTara: 1,
      totalPrice: 730,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      70,
    );
    expect(line).toBe(
      '4по70 +1 бак = 730 грн\n📍 Хмельницького 2 кв5\n👤 Іван',
    );
  });

  it('own-tara with a pump add-on shows +помпа', () => {
    const order = makeOrder({
      kind: 'OWN_TARA',
      bottles: 2,
      pumpAddon: true,
      totalPrice: 390,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      70,
    );
    expect(line).toContain('2по70 +помпа = 390 грн');
  });

  it('starter kit: a [ПЕРШИЙ N +помпа] marker instead of per-bottle', () => {
    const order = makeOrder({
      kind: 'STARTER_KIT',
      bottles: 1,
      newTara: 1,
      totalPrice: 750,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      80,
    );
    expect(line.split('\n')[0]).toBe('[ПЕРШИЙ 1 +помпа] = 750 грн');
  });

  it('starter kit with an electric pump → +електро', () => {
    const order = makeOrder({
      kind: 'STARTER_KIT',
      bottles: 1,
      electro: true,
      totalPrice: 770,
    });
    const line = driverLine(
      order,
      makeClient(),
      makeAddress({ comment: null }),
      80,
    );
    expect(line.split('\n')[0]).toBe('[ПЕРШИЙ 1 +електро] = 770 грн');
  });

  it('appends a maps link when the address is geo-tagged', () => {
    const line = driverLine(
      makeOrder(),
      makeClient(),
      makeAddress({ lat: 49.42, lng: 26.99 }),
      70,
    );
    expect(line).toContain('🗺 https://maps.google.com/?q=49.42,26.99');
  });

  it('falls back to "без імені" when the client has no name', () => {
    const line = driverLine(makeOrder(), makeClient(null), makeAddress(), 70);
    expect(line).toContain('👤 без імені');
  });

  it('includes the client order note when present', () => {
    const line = driverLine(
      makeOrder({ note: 'мене не буде з 14 до 16' }),
      makeClient(),
      makeAddress({ comment: null }),
      70,
    );
    expect(line).toContain('📝 мене не буде з 14 до 16');
  });
});

describe('delivery-timing (ETA) picker', () => {
  it('deliveryEtaPreset maps known keys and rejects unknown', () => {
    expect(deliveryEtaPreset('td')).toBe('сьогодні');
    expect(deliveryEtaPreset('tm')).toBe('завтра');
    expect(deliveryEtaPreset('h1')).toBe('протягом години');
    expect(deliveryEtaPreset('h2')).toBe('протягом 2 годин');
    expect(deliveryEtaPreset('zzz')).toBeUndefined();
  });

  it('deliveryEtaKeyboard carries preset / custom / cancel callbacks with the order id', () => {
    const cbs = JSON.stringify(deliveryEtaKeyboard('o1').inline_keyboard);
    expect(cbs).toContain('etap:td:o1');
    expect(cbs).toContain('etap:tm:o1');
    expect(cbs).toContain('etap:h1:o1');
    expect(cbs).toContain('etap:h2:o1');
    expect(cbs).toContain('etac:o1');
    expect(cbs).toContain('etax:o1');
  });
});

describe('orderMessage', () => {
  it('REPEAT (no top-up): status header, exchange composition, price and contact', () => {
    const msg = orderMessage(makeCardOrder(), makeCardClient(), makeAddress());
    expect(msg).toContain('🔔 НОВЕ ЗАМОВЛЕННЯ #abcd1234');
    expect(msg).toContain('📦 2 бут. — обмін');
    expect(msg).toContain('👤 Іван (+380501234567)');
    expect(msg).toContain('💰 280 грн готівкою водієві');
    // No OWN_TARA/STARTER_KIT mark on a plain repeat.
    expect(msg).not.toContain('СВОЯ ТАРА');
    expect(msg).not.toContain('ПЕРШЕ ЗАМОВЛЕННЯ');
  });

  it('REPEAT with a tara top-up shows exchange + new-under-deposit split', () => {
    const msg = orderMessage(
      makeCardOrder({ bottles: 3, newTara: 1, totalPrice: 660 }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).toContain('📦 3 бут.: 2 обмін + 1 нові (застава)');
  });

  it('OWN_TARA marks the declared bottle count (claimedOnHand) for physical verification', () => {
    const msg = orderMessage(
      makeCardOrder({ kind: OrderKind.OWN_TARA, claimedOnHand: 4 }),
      makeCardClient(),
      makeAddress(),
    );
    expect(msg).toContain('[СВОЯ ТАРА ⚠️ звірити 4 баків]');
    expect(msg).toContain('📦 2 бут. — своя тара, обмін');
  });

  it('OWN_TARA falls back to the ordered count when claimedOnHand is null', () => {
    const msg = orderMessage(
      makeCardOrder({
        kind: OrderKind.OWN_TARA,
        claimedOnHand: null,
        bottles: 3,
      }),
      makeCardClient(),
      makeAddress(),
    );
    expect(msg).toContain('звірити 3 баків');
  });

  it('OWN_TARA with a pump add-on shows the +помпа (докупка) line', () => {
    const msg = orderMessage(
      makeCardOrder({
        kind: OrderKind.OWN_TARA,
        claimedOnHand: 2,
        pumpAddon: true,
      }),
      makeCardClient(),
      makeAddress(),
    );
    expect(msg).toContain('🔌 + помпа (докупка)');
  });

  it('STARTER_KIT marks a first order and shows the pump type', () => {
    const msg = orderMessage(
      makeCardOrder({
        kind: OrderKind.STARTER_KIT,
        bottles: 2,
        newTara: 2,
        electro: true,
        totalPrice: 1290,
      }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).toContain('[ПЕРШЕ ЗАМОВЛЕННЯ ⚠️]');
    expect(msg).toContain('стартовий комплект (застава за 2)');
    expect(msg).toContain('🔌 помпа: електрична');
  });

  it('renders a maps link only when the address is geo-tagged', () => {
    const tagged = orderMessage(
      makeCardOrder(),
      makeCardClient(),
      makeAddress({ lat: 49.42, lng: 26.99, comment: null }),
    );
    expect(tagged).toContain('🗺 https://maps.google.com/?q=49.42,26.99');

    const untagged = orderMessage(
      makeCardOrder(),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(untagged).not.toContain('🗺');
  });

  it('uses the status-specific header (ACCEPTED)', () => {
    const msg = orderMessage(
      makeCardOrder({ status: OrderStatus.ACCEPTED }),
      makeCardClient(),
      makeAddress(),
    );
    expect(msg).toContain('✅ ПРИЙНЯТО');
  });

  it('falls back to "без імені" for a nameless client', () => {
    const msg = orderMessage(
      makeCardOrder(),
      makeCardClient({ name: null }),
      makeAddress(),
    );
    expect(msg).toContain('👤 без імені');
  });

  it('shows the client order note and the delivery-note echo when present', () => {
    const msg = orderMessage(
      makeCardOrder({
        note: 'мене не буде з 14 до 16',
        deliveryNote: 'сьогодні',
      }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).toContain('📝 мене не буде з 14 до 16');
    expect(msg).toContain('🗓 Клієнту: сьогодні');
  });

  it('omits the note / delivery-echo lines when absent', () => {
    const msg = orderMessage(
      makeCardOrder({ note: null, deliveryNote: null }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).not.toContain('📝');
    expect(msg).not.toContain('🗓');
  });

  it('shows the cancellation reason on a cancelled card', () => {
    const msg = orderMessage(
      makeCardOrder({
        status: OrderStatus.CANCELLED,
        cancelReason: 'поза зоною',
      }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).toContain('❌ Причина: поза зоною');
  });

  it('omits the reason line for a non-cancelled order (even if a stale reason lingers)', () => {
    const msg = orderMessage(
      makeCardOrder({
        status: OrderStatus.CREATED,
        cancelReason: 'поза зоною',
      }),
      makeCardClient(),
      makeAddress({ comment: null }),
    );
    expect(msg).not.toContain('Причина');
  });
});

describe('cancellation reason (❌ picker)', () => {
  it('cancelReasonPreset maps known keys and rejects unknown', () => {
    expect(cancelReasonPreset('zone')).toBe('поза зоною');
    expect(cancelReasonPreset('mind')).toBe('клієнт передумав');
    expect(cancelReasonPreset('dup')).toBe('дубль замовлення');
    expect(cancelReasonPreset('noans')).toBe('немає зв’язку з клієнтом');
    expect(cancelReasonPreset('zzz')).toBeUndefined();
  });

  it('the reason keyboard carries a canr:<key>:<id> per preset, plus custom + dismiss', () => {
    const cbs = JSON.stringify(confirmCancelKeyboard('o1').inline_keyboard);
    expect(cbs).toContain('canr:zone:o1');
    expect(cbs).toContain('canr:mind:o1');
    expect(cbs).toContain('canr:dup:o1');
    expect(cbs).toContain('canr:noans:o1');
    expect(cbs).toContain('canx:o1'); // ✏️ Інша причина
    expect(cbs).toContain('cann:o1'); // Ні, залишити
  });

  it('cancelReasonCustomPrompt names the order', () => {
    expect(cancelReasonCustomPrompt('abcd1234ef')).toContain('#abcd1234');
  });
});

describe('orderKeyboard — action buttons by status/kind', () => {
  function callbacks(kb: ReturnType<typeof orderKeyboard>): string {
    return JSON.stringify(kb?.inline_keyboard ?? []);
  }

  it('CREATED non-OWN_TARA: accept/cancel/edit/eta/geo/driver-line, no claim button', () => {
    const kb = orderKeyboard('o1', OrderStatus.CREATED, OrderKind.REPEAT);
    const cbs = callbacks(kb);
    expect(cbs).toContain('acc:o1');
    expect(cbs).toContain('can:o1');
    expect(cbs).toContain('edit:o1');
    expect(cbs).toContain('eta:o1');
    expect(cbs).toContain('geo:o1');
    expect(cbs).toContain('drvline:o1');
    expect(cbs).not.toContain('claim:o1');
    // No delivered button before acceptance.
    expect(cbs).not.toContain('del:o1');
  });

  it('CREATED OWN_TARA adds the "звірити баки" (claim) button', () => {
    const kb = orderKeyboard('o1', OrderStatus.CREATED, OrderKind.OWN_TARA);
    expect(callbacks(kb)).toContain('claim:o1');
  });

  it('ACCEPTED: delivered/cancel/edit/eta/geo/driver-line, no accept/claim button', () => {
    const kb = orderKeyboard('o1', OrderStatus.ACCEPTED, OrderKind.REPEAT);
    const cbs = callbacks(kb);
    expect(cbs).toContain('del:o1');
    expect(cbs).toContain('can:o1');
    expect(cbs).toContain('edit:o1');
    expect(cbs).toContain('eta:o1');
    expect(cbs).not.toContain('acc:o1');
    expect(cbs).not.toContain('claim:o1');
  });

  it('DELIVERED / CANCELLED are terminal → no keyboard (undefined)', () => {
    expect(orderKeyboard('o1', OrderStatus.DELIVERED)).toBeUndefined();
    expect(orderKeyboard('o1', OrderStatus.CANCELLED)).toBeUndefined();
  });
});

describe('clientCardMessage', () => {
  it('shows identity, balance, pump and default address', () => {
    const msg = clientCardMessage(
      makeCardClient(),
      makeAddress({ raw: 'St. 5', comment: 'floor 3' }),
      null,
    );
    expect(msg).toContain('👤 Іван (+380501234567)');
    expect(msg).toContain('🪣 баків на руках: 5, є помпа');
    expect(msg).toContain('📍 St. 5 (floor 3)');
    expect(msg).not.toContain('на звірці');
  });

  it('flags a pending review and "без помпи" when applicable', () => {
    const msg = clientCardMessage(
      makeCardClient({ pendingReview: true, hasPump: false, bottlesOnHand: 0 }),
      null,
      null,
    );
    expect(msg).toContain('⚠️ на звірці');
    expect(msg).toContain('🪣 баків на руках: 0, без помпи');
  });

  it('says there is no address yet when the client has none', () => {
    const msg = clientCardMessage(makeCardClient(), null, null);
    expect(msg).toContain('📍 адреси ще немає');
  });

  it('appends the last order line when present', () => {
    const msg = clientCardMessage(
      makeCardClient(),
      makeAddress({ comment: null }),
      makeCardOrder({ bottles: 3, totalPrice: 210 }),
    );
    expect(msg).toContain('🕒 останнє:');
    expect(msg).toContain('3 бут., 210 грн');
  });

  it('adds a maps link on a geo-tagged address', () => {
    const msg = clientCardMessage(
      makeCardClient(),
      makeAddress({ lat: 49.42, lng: 26.99, comment: null }),
      null,
    );
    expect(msg).toContain('🗺 https://maps.google.com/?q=49.42,26.99');
  });
});

describe('summary / prompt texts', () => {
  it('statsMessage renders the full operator summary (queue, periods, bottles, avg check, cancels)', () => {
    const msg = statsMessage({
      queue: { created: 3, accepted: 2 },
      today: { count: 2, sum: 500, bottles: 6 },
      week: { count: 7, sum: 1800, bottles: 20 },
      month: { count: 18, sum: 5400 },
      cancellations: { today: 1, week: 3, weekRate: 0.3 },
    });
    expect(msg).toBe(
      '📊 Статистика (без скасованих)\n\n' +
        '⏳ У черзі: 3 нових · 2 в роботі\n\n' +
        '📅 Сьогодні: 2 замовл., 500 грн, 6 бут.\n' +
        '🗓 Тиждень: 7 замовл., 1800 грн, 20 бут.\n' +
        // average check = 1800 / 7 = 257.14… → rounded 257
        '💵 Середній чек (тиждень): 257 грн\n' +
        '📆 Місяць: 18 замовл., 5400 грн\n\n' +
        '❌ Скасувань: 1 сьогодні · 3 за тиждень (30%)',
    );
  });

  it('statsMessage shows «—» for the average check and cancel rate on empty/zero data', () => {
    const msg = statsMessage({
      queue: { created: 0, accepted: 0 },
      today: { count: 0, sum: 0, bottles: 0 },
      week: { count: 0, sum: 0, bottles: 0 },
      month: { count: 0, sum: 0 },
      cancellations: { today: 0, week: 0, weekRate: null },
    });
    // Divide-by-zero guard: no week orders → both derived figures are «—».
    expect(msg).toContain('💵 Середній чек (тиждень): —');
    expect(msg).toContain('❌ Скасувань: 0 сьогодні · 0 за тиждень (—)');
  });

  it('pricesMessage lists the full grid and add-on prices', () => {
    const msg = pricesMessage(cardPrices);
    expect(msg).toContain('Вода: 1 — 80, від 2 — 70, від 6 — 65 грн');
    expect(msg).toContain('Застава за бак: 450 грн');
    expect(msg).toContain('Помпа: 250 грн (електро 270)');
    expect(msg).toContain('Старт-вода: 50 грн/бак');
  });

  it('priceFieldLabel maps every editable field to a human label', () => {
    expect(priceFieldLabel('price1')).toBe('Вода: 1 бутель');
    expect(priceFieldLabel('depositPerBottle')).toBe('Застава за бак');
    expect(priceFieldLabel('electroPumpPrice')).toBe('Помпа електро');
  });

  it('activeOrdersHeader includes the count', () => {
    expect(activeOrdersHeader(3)).toBe('📋 Активні замовлення: 3');
  });

  describe('active orders summary (/orders overview)', () => {
    const now = new Date('2026-07-03T12:00:00.000Z');
    const at = (min: number) => new Date(now.getTime() - min * 60_000);
    const line = (over: Partial<QueueOrder>): QueueOrder => ({
      id: 'aaaaaaaabbbb',
      status: OrderStatus.CREATED,
      kind: OrderKind.REPEAT,
      createdAt: at(10),
      ...over,
    });

    it('header with totals by status, oldest-new age, and a one-liner per order', () => {
      const sorted: QueueOrder[] = [
        line({
          id: 'a1b2c3d4ffff',
          status: OrderStatus.CREATED,
          kind: OrderKind.OWN_TARA,
          createdAt: at(42),
        }),
        line({
          id: 'e5f6a7b8ffff',
          status: OrderStatus.ACCEPTED,
          kind: OrderKind.REPEAT,
          createdAt: at(70),
        }),
      ];
      const summary: QueueSummary = {
        total: 2,
        created: 1,
        accepted: 1,
        oldestCreated: sorted[0],
      };
      const out = activeOrdersSummary(sorted, summary, now);
      expect(out).toContain('📋 Активні: 2 · 🆕 нових: 1 · ✅ в роботі: 1');
      expect(out).toContain('⏳ найстаріше нове: 42 хв тому');
      expect(out).toContain('🆕 #a1b2c3d4 · своя тара · 42 хв');
      expect(out).toContain('✅ #e5f6a7b8 · обмін · 1 год');
    });

    it('omits the oldest-new line when nothing is unhandled', () => {
      const sorted: QueueOrder[] = [
        line({ status: OrderStatus.ACCEPTED, createdAt: at(5) }),
      ];
      const summary: QueueSummary = {
        total: 1,
        created: 0,
        accepted: 1,
        oldestCreated: null,
      };
      const out = activeOrdersSummary(sorted, summary, now);
      expect(out).toContain('🆕 нових: 0');
      expect(out).not.toContain('найстаріше нове');
    });

    it('activeOrdersCappedNote references the remaining in-progress count', () => {
      expect(activeOrdersCappedNote(4)).toContain('ще 4 в роботі');
    });
  });

  it('the prompts reference the short order id (first 8 chars)', () => {
    expect(editQuantityPrompt('abcd1234ef')).toContain('#abcd1234');
    expect(editAddressPrompt('abcd1234ef')).toContain('#abcd1234');
    expect(editCommentPrompt('abcd1234ef')).toContain('#abcd1234');
    expect(editMenuPrompt('abcd1234ef')).toContain('#abcd1234');
    expect(geoTagPrompt('abcd1234ef')).toContain('#abcd1234');
    expect(editClaimPrompt('abcd1234ef')).toContain('#abcd1234');
  });

  it('editMenuKeyboard offers qty/addr/comment field buttons + cancel', () => {
    const cbs = JSON.stringify(editMenuKeyboard('o1').inline_keyboard);
    expect(cbs).toContain('ef:qty:o1');
    expect(cbs).toContain('ef:addr:o1');
    expect(cbs).toContain('ef:comment:o1');
    expect(cbs).toContain('ef_cancel');
  });

  it('clientCancelledMessage and callbackRequestMessage carry client identity', () => {
    const cancelled = clientCancelledMessage(makeCardOrder(), makeCardClient());
    expect(cancelled).toContain('#abcd1234');
    expect(cancelled).toContain('Іван (+380501234567)');

    const callback = callbackRequestMessage(makeCardClient({ name: null }));
    expect(callback).toContain('ЗАПИТ НА ДЗВІНОК');
    expect(callback).toContain('без імені');
  });

  describe('contacts (support phones)', () => {
    const makeContact = (over: Partial<ContactPhone> = {}): ContactPhone => ({
      id: 'ct1',
      phone: '+380501234567',
      active: true,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...over,
    });

    it('empty list explains the env fallback', () => {
      expect(contactsListMessage([])).toContain('резервний номер');
    });

    it('marks active with ✅ and hidden with 🙈', () => {
      const out = contactsListMessage([
        makeContact({ phone: '+380501112233', active: true }),
        makeContact({ id: 'ct2', phone: '+380504445566', active: false }),
      ]);
      expect(out).toContain('✅ +380501112233');
      expect(out).toContain('🙈 +380504445566');
    });

    it('keyboard has a toggle + delete per number and an add button', () => {
      const kb = contactsKeyboard([makeContact({ id: 'ct9' })]);
      const cbs = kb.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data: string }).callback_data);
      expect(cbs).toContain('ct:tgl:ct9');
      expect(cbs).toContain('ct:del:ct9');
      expect(cbs).toContain('ct:add');
    });
  });
});
