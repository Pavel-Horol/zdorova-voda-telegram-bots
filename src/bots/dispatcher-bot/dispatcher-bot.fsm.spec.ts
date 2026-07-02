import {
  BTN_CLIENT,
  BTN_CONTACTS,
  BTN_ORDERS,
  BTN_PRICES,
  BTN_STATS,
  formatChatTitle,
  parseDispatcherInput,
  parseEditedQuantity,
  parseGeoInput,
  parsePriceValue,
  phoneSearchToken,
  routeDispatcherText,
} from './dispatcher-bot.fsm';

/**
 * Characterization tests for the dispatcher's onText: pin the CURRENT branching
 * (former body of onText/applyEditedQuantity). The table mirrors every branch of the
 * original handlers, including button priority over input modes and number bounds.
 */
describe('routeDispatcherText', () => {
  const noMode = {};

  it('"Active" button → orders menu (even with an active input mode)', () => {
    expect(routeDispatcherText(BTN_ORDERS, noMode)).toEqual({
      kind: 'menu',
      action: 'orders',
    });
    expect(
      routeDispatcherText(BTN_ORDERS, {
        editingOrder: { id: 'o1', field: 'qty' },
        editingPriceField: 'price1',
      }),
    ).toEqual({ kind: 'menu', action: 'orders' });
  });

  it('"Prices" button → prices menu (priority over a price value input)', () => {
    expect(
      routeDispatcherText(BTN_PRICES, { editingPriceField: 'price1' }),
    ).toEqual({ kind: 'menu', action: 'prices' });
  });

  it('"Stats" button → stats menu', () => {
    expect(routeDispatcherText(BTN_STATS, noMode)).toEqual({
      kind: 'menu',
      action: 'stats',
    });
  });

  it('order editing has priority over price editing (mutually exclusive modes)', () => {
    expect(
      routeDispatcherText('5', {
        editingOrder: { id: 'o1', field: 'qty' },
        editingPriceField: 'price1',
      }),
    ).toEqual({ kind: 'edit-order', orderId: 'o1', field: 'qty' });
  });

  it('only order editing is active → edit-order (carries the picked field)', () => {
    expect(
      routeDispatcherText('5', { editingOrder: { id: 'o42', field: 'qty' } }),
    ).toEqual({ kind: 'edit-order', orderId: 'o42', field: 'qty' });
    expect(
      routeDispatcherText('вул. Нова 5', {
        editingOrder: { id: 'o42', field: 'addr' },
      }),
    ).toEqual({ kind: 'edit-order', orderId: 'o42', field: 'addr' });
    expect(
      routeDispatcherText('код 42', {
        editingOrder: { id: 'o42', field: 'comment' },
      }),
    ).toEqual({ kind: 'edit-order', orderId: 'o42', field: 'comment' });
  });

  it('only claim editing is active → edit-claim (step B)', () => {
    expect(routeDispatcherText('3', { editingClaimOrderId: 'o7' })).toEqual({
      kind: 'edit-claim',
      orderId: 'o7',
    });
  });

  it('claim editing has priority over price editing (mutually exclusive modes)', () => {
    expect(
      routeDispatcherText('3', {
        editingClaimOrderId: 'o7',
        editingPriceField: 'price1',
      }),
    ).toEqual({ kind: 'edit-claim', orderId: 'o7' });
  });

  it('only geo-tagging is active → set-geo', () => {
    expect(
      routeDispatcherText('49.42, 26.99', { geoTaggingOrderId: 'o9' }),
    ).toEqual({ kind: 'set-geo', orderId: 'o9' });
  });

  it('only delivery-note input is active → set-delivery-note', () => {
    expect(
      routeDispatcherText('завтра після обіду', {
        deliveryNoteOrderId: 'o11',
      }),
    ).toEqual({ kind: 'set-delivery-note', orderId: 'o11' });
  });

  it('"Client" button → client lookup menu', () => {
    expect(routeDispatcherText(BTN_CLIENT, noMode)).toEqual({
      kind: 'menu',
      action: 'client',
    });
  });

  it('only client lookup is active → lookup-client', () => {
    expect(routeDispatcherText('050', { lookupClient: true })).toEqual({
      kind: 'lookup-client',
    });
  });

  it('only price editing is active → edit-price', () => {
    expect(
      routeDispatcherText('30', { editingPriceField: 'pumpPrice' }),
    ).toEqual({ kind: 'edit-price', field: 'pumpPrice' });
  });

  it('"Contacts" button → contacts menu', () => {
    expect(routeDispatcherText(BTN_CONTACTS, noMode)).toEqual({
      kind: 'menu',
      action: 'contacts',
    });
  });

  it('only adding-contact is active → add-contact', () => {
    expect(
      routeDispatcherText('+380501234567', { addingContact: true }),
    ).toEqual({ kind: 'add-contact' });
  });

  it('the Contacts button wins over an active adding-contact mode', () => {
    expect(routeDispatcherText(BTN_CONTACTS, { addingContact: true })).toEqual({
      kind: 'menu',
      action: 'contacts',
    });
  });

  it('only adding-dispatcher is active → add-dispatcher', () => {
    expect(
      routeDispatcherText('626688964 Іван', { addingDispatcher: true }),
    ).toEqual({ kind: 'add-dispatcher' });
  });

  it('neither a button nor an active mode → ignore', () => {
    expect(routeDispatcherText('привіт', noMode)).toEqual({ kind: 'ignore' });
  });
});

describe('parseDispatcherInput', () => {
  it('parses a bare chat id with no label', () => {
    expect(parseDispatcherInput('626688964')).toEqual({
      chatId: '626688964',
      label: null,
    });
  });

  it('splits off a free-text label after the id', () => {
    expect(parseDispatcherInput('  626688964   Іван Диспетчер ')).toEqual({
      chatId: '626688964',
      label: 'Іван Диспетчер',
    });
  });

  it('accepts a negative (group) chat id', () => {
    expect(parseDispatcherInput('-1001234567890 Склад')).toEqual({
      chatId: '-1001234567890',
      label: 'Склад',
    });
  });

  it('rejects a non-integer id and empty input', () => {
    expect(parseDispatcherInput('Іван 626688964')).toBeNull();
    expect(parseDispatcherInput('12.5')).toBeNull();
    expect(parseDispatcherInput('')).toBeNull();
  });
});

describe('formatChatTitle', () => {
  it('uses the group/channel title when present', () => {
    expect(formatChatTitle({ title: 'Склад №2', first_name: 'x' })).toBe(
      'Склад №2',
    );
  });

  it('joins first + last name for a private chat', () => {
    expect(formatChatTitle({ first_name: 'Іван', last_name: 'Петренко' })).toBe(
      'Іван Петренко',
    );
  });

  it('appends @username to the name when both are present', () => {
    expect(formatChatTitle({ first_name: 'Іван', username: 'ivan' })).toBe(
      'Іван (@ivan)',
    );
  });

  it('falls back to @username, then to null', () => {
    expect(formatChatTitle({ username: 'ivan' })).toBe('@ivan');
    expect(formatChatTitle({})).toBeNull();
  });
});

describe('parseEditedQuantity', () => {
  const MAX = 100;

  it('valid integer in the range [1, max]', () => {
    expect(parseEditedQuantity('1', MAX)).toEqual({ ok: true, value: 1 });
    expect(parseEditedQuantity('5', MAX)).toEqual({ ok: true, value: 5 });
    expect(parseEditedQuantity('100', MAX)).toEqual({ ok: true, value: 100 });
  });

  it('less than 1 → rejection', () => {
    expect(parseEditedQuantity('0', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('-3', MAX)).toEqual({ ok: false });
  });

  it('greater than max → rejection', () => {
    expect(parseEditedQuantity('101', MAX)).toEqual({ ok: false });
  });

  it('non-integer / not a number → rejection', () => {
    expect(parseEditedQuantity('2.5', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('abc', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('', MAX)).toEqual({ ok: false });
  });
});

describe('parsePriceValue', () => {
  it('valid non-negative integer (0 allowed)', () => {
    expect(parsePriceValue('0')).toEqual({ ok: true, value: 0 });
    expect(parsePriceValue('250')).toEqual({ ok: true, value: 250 });
  });

  it('negative → rejection', () => {
    expect(parsePriceValue('-1')).toEqual({ ok: false });
  });

  it('non-integer / not a number → rejection', () => {
    expect(parsePriceValue('99.9')).toEqual({ ok: false });
    expect(parsePriceValue('грн')).toEqual({ ok: false });
  });
});

describe('parseGeoInput', () => {
  it('plain "lat, lng" (with or without spaces) → coords', () => {
    expect(parseGeoInput('49.42, 26.99')).toEqual({ lat: 49.42, lng: 26.99 });
    expect(parseGeoInput('49.42,26.99')).toEqual({ lat: 49.42, lng: 26.99 });
  });

  it('Google Maps links (@lat,lng / q= / ll=) → coords', () => {
    expect(
      parseGeoInput(
        'https://www.google.com/maps/place/X/@49.42,26.99,17z/data',
      ),
    ).toEqual({ lat: 49.42, lng: 26.99 });
    expect(parseGeoInput('https://maps.google.com/?q=49.42,26.99')).toEqual({
      lat: 49.42,
      lng: 26.99,
    });
    expect(parseGeoInput('https://maps.google.com/?ll=49.42,26.99')).toEqual({
      lat: 49.42,
      lng: 26.99,
    });
  });

  it('OpenStreetMap links (#map / mlat&mlon) → coords', () => {
    expect(
      parseGeoInput('https://www.openstreetmap.org/#map=18/49.42/26.99'),
    ).toEqual({
      lat: 49.42,
      lng: 26.99,
    });
    expect(
      parseGeoInput('https://www.openstreetmap.org/?mlat=49.42&mlon=26.99'),
    ).toEqual({ lat: 49.42, lng: 26.99 });
  });

  it('out-of-range coordinates → null', () => {
    expect(parseGeoInput('100, 26.99')).toBeNull(); // lat > 90
    expect(parseGeoInput('49.42, 200')).toBeNull(); // lng > 180
  });

  it('non-geo text (a textual maps query, a bare number, garbage) → null', () => {
    expect(
      parseGeoInput('https://maps.google.com/?q=Хмельницького'),
    ).toBeNull();
    expect(parseGeoInput('5')).toBeNull();
    expect(parseGeoInput('привіт')).toBeNull();
  });
});

describe('phoneSearchToken', () => {
  it('returns the last up to 9 digits, ignoring formatting', () => {
    expect(phoneSearchToken('+380501234567')).toBe('501234567');
    expect(phoneSearchToken('0501234567')).toBe('501234567');
    expect(phoneSearchToken('501234567')).toBe('501234567');
    expect(phoneSearchToken('+38 (050) 123-45-67')).toBe('501234567');
  });

  it('a short fragment (>= 5 digits) is kept as is', () => {
    expect(phoneSearchToken('34567')).toBe('34567');
  });

  it('too few digits → null', () => {
    expect(phoneSearchToken('1234')).toBeNull();
    expect(phoneSearchToken('абв')).toBeNull();
    expect(phoneSearchToken('')).toBeNull();
  });
});
