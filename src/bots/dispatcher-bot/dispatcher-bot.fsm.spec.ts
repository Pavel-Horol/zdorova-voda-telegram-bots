import {
  BTN_ORDERS,
  BTN_PRICES,
  BTN_STATS,
  parseEditedQuantity,
  parsePriceValue,
  routeDispatcherText,
} from './dispatcher-bot.fsm';

/**
 * Characterization-тесты диспетчерского onText: фиксируют ТЕКУЩЕЕ ветвление
 * (бывшее тело onText/applyEditedQuantity). Таблица повторяет все ветки
 * исходных хендлеров, включая приоритет кнопок над режимами ввода и границы чисел.
 */
describe('routeDispatcherText', () => {
  const noMode = {};

  it('кнопка «Активные» → меню orders (даже при активном режиме ввода)', () => {
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

  it('кнопка «Цены» → меню prices (приоритет над вводом значения цены)', () => {
    expect(
      routeDispatcherText(BTN_PRICES, { editingPriceField: 'price1' }),
    ).toEqual({ kind: 'menu', action: 'prices' });
  });

  it('кнопка «Статистика» → меню stats', () => {
    expect(routeDispatcherText(BTN_STATS, noMode)).toEqual({
      kind: 'menu',
      action: 'stats',
    });
  });

  it('правка количества имеет приоритет над правкой цены (режимы взаимоисключающие)', () => {
    expect(
      routeDispatcherText('5', {
        editingOrderId: 'o1',
        editingPriceField: 'price1',
      }),
    ).toEqual({ kind: 'edit-quantity', orderId: 'o1' });
  });

  it('активна только правка количества → edit-quantity', () => {
    expect(routeDispatcherText('5', { editingOrderId: 'o42' })).toEqual({
      kind: 'edit-quantity',
      orderId: 'o42',
    });
  });

  it('активна только правка цены → edit-price', () => {
    expect(
      routeDispatcherText('30', { editingPriceField: 'pumpPrice' }),
    ).toEqual({ kind: 'edit-price', field: 'pumpPrice' });
  });

  it('нет ни кнопки, ни активного режима → ignore', () => {
    expect(routeDispatcherText('привет', noMode)).toEqual({ kind: 'ignore' });
  });
});

describe('parseEditedQuantity', () => {
  const MAX = 100;

  it('валидное целое в диапазоне [1, max]', () => {
    expect(parseEditedQuantity('1', MAX)).toEqual({ ok: true, value: 1 });
    expect(parseEditedQuantity('5', MAX)).toEqual({ ok: true, value: 5 });
    expect(parseEditedQuantity('100', MAX)).toEqual({ ok: true, value: 100 });
  });

  it('меньше 1 → отказ', () => {
    expect(parseEditedQuantity('0', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('-3', MAX)).toEqual({ ok: false });
  });

  it('больше max → отказ', () => {
    expect(parseEditedQuantity('101', MAX)).toEqual({ ok: false });
  });

  it('не целое / не число → отказ', () => {
    expect(parseEditedQuantity('2.5', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('abc', MAX)).toEqual({ ok: false });
    expect(parseEditedQuantity('', MAX)).toEqual({ ok: false });
  });
});

describe('parsePriceValue', () => {
  it('валидное целое неотрицательное (0 допустим)', () => {
    expect(parsePriceValue('0')).toEqual({ ok: true, value: 0 });
    expect(parsePriceValue('250')).toEqual({ ok: true, value: 250 });
  });

  it('отрицательное → отказ', () => {
    expect(parsePriceValue('-1')).toEqual({ ok: false });
  });

  it('не целое / не число → отказ', () => {
    expect(parsePriceValue('99.9')).toEqual({ ok: false });
    expect(parsePriceValue('грн')).toEqual({ ok: false });
  });
});
