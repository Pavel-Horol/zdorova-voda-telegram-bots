import {
  BTN_ORDERS,
  BTN_PRICES,
  BTN_STATS,
  parseEditedQuantity,
  parseGeoInput,
  parsePriceValue,
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
        editingOrderId: 'o1',
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

  it('quantity editing has priority over price editing (mutually exclusive modes)', () => {
    expect(
      routeDispatcherText('5', {
        editingOrderId: 'o1',
        editingPriceField: 'price1',
      }),
    ).toEqual({ kind: 'edit-quantity', orderId: 'o1' });
  });

  it('only quantity editing is active → edit-quantity', () => {
    expect(routeDispatcherText('5', { editingOrderId: 'o42' })).toEqual({
      kind: 'edit-quantity',
      orderId: 'o42',
    });
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

  it('only price editing is active → edit-price', () => {
    expect(
      routeDispatcherText('30', { editingPriceField: 'pumpPrice' }),
    ).toEqual({ kind: 'edit-price', field: 'pumpPrice' });
  });

  it('neither a button nor an active mode → ignore', () => {
    expect(routeDispatcherText('привіт', noMode)).toEqual({ kind: 'ignore' });
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
