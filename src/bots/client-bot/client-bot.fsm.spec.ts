import {
  MAX_ORDER_QTY,
  parseQty,
  resolveAfterQty,
  resolveBack,
  resolveConfirm,
  resolveFinalizeAddress,
  resolveStartOrder,
  Step,
} from './client-bot.fsm';

/**
 * Characterization-тесты «Назад» (бывший onBack): фиксируют ТЕКУЩЕЕ поведение
 * ветвления по снятому со стека шагу. Таблица повторяет все ветки исходного
 * хендлера, включая защитную (пустой стек) и зависящую от адреса.
 */
describe('resolveBack', () => {
  it('пустой стек (prev === undefined) → главное меню', () => {
    expect(resolveBack(undefined, false)).toBe('main-menu');
    expect(resolveBack(undefined, true)).toBe('main-menu');
  });

  it('prev === MainMenu → главное меню', () => {
    expect(resolveBack(Step.MainMenu, false)).toBe('main-menu');
  });

  it('prev === AwaitAddress → промпт адреса', () => {
    expect(resolveBack(Step.AwaitAddress, true)).toBe('address-prompt');
  });

  it('prev === AwaitComment → промпт комментария', () => {
    expect(resolveBack(Step.AwaitComment, true)).toBe('comment-prompt');
  });

  describe('prev === ChooseQty (зависит от наличия адреса)', () => {
    it('адрес есть → выбор количества', () => {
      expect(resolveBack(Step.ChooseQty, true)).toBe('choose-qty');
    });

    it('адреса нет → обратно к вводу адреса', () => {
      expect(resolveBack(Step.ChooseQty, false)).toBe('address-prompt');
    });
  });

  it('адрес важен только для ветки количества, остальные его игнорируют', () => {
    expect(resolveBack(Step.MainMenu, true)).toBe(
      resolveBack(Step.MainMenu, false),
    );
    expect(resolveBack(Step.AwaitAddress, true)).toBe(
      resolveBack(Step.AwaitAddress, false),
    );
    expect(resolveBack(Step.AwaitComment, true)).toBe(
      resolveBack(Step.AwaitComment, false),
    );
  });
});

/**
 * Characterization-тесты валидации количества (бывшая инлайн-логика onChooseQty):
 * фиксируют ТЕКУЩЕЕ поведение для корректных, граничных и подделанных значений
 * callback'а. Раньше невалидный ввод приводил к молчаливому `return` в хендлере —
 * здесь это `null` (хендлер на `null` так же выходит без действий).
 */
describe('parseQty', () => {
  it('корректное количество в диапазоне 1..MAX_ORDER_QTY → само число', () => {
    expect(parseQty('1')).toBe(1);
    expect(parseQty('3')).toBe(3);
    expect(parseQty('5')).toBe(5);
  });

  it('граница MAX_ORDER_QTY включительно → число', () => {
    expect(parseQty(String(MAX_ORDER_QTY))).toBe(MAX_ORDER_QTY);
  });

  it('превышение MAX_ORDER_QTY (подделанный callback) → null', () => {
    expect(parseQty(String(MAX_ORDER_QTY + 1))).toBeNull();
    expect(parseQty('1000')).toBeNull();
  });

  it('значение меньше 1 → null', () => {
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-5')).toBeNull();
  });

  it('не целое число → null', () => {
    expect(parseQty('2.5')).toBeNull();
  });

  it('не число → null', () => {
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('')).toBeNull();
    expect(parseQty('3a')).toBeNull();
  });
});

/**
 * Юнит-тесты переходов, перенесённых из хендлеров (onChooseQty / finalizeAddress
 * / renderConfirm). Поведение тождественно исходным веткам в сервисе.
 */
describe('resolveStartOrder (из startOrder)', () => {
  it('адреса нет → промпт адреса (первый заказ), вне зависимости от прошлого заказа', () => {
    expect(resolveStartOrder(false, null)).toEqual({ kind: 'address-prompt' });
    expect(resolveStartOrder(false, 3)).toEqual({ kind: 'address-prompt' });
  });

  it('адрес есть и был прошлый заказ → confirm с прошлым количеством (повтор в один тап)', () => {
    expect(resolveStartOrder(true, 3)).toEqual({ kind: 'confirm', bottles: 3 });
    expect(resolveStartOrder(true, MAX_ORDER_QTY)).toEqual({
      kind: 'confirm',
      bottles: MAX_ORDER_QTY,
    });
  });

  it('адрес есть, заказов не было (null/0) → выбор количества', () => {
    expect(resolveStartOrder(true, null)).toEqual({ kind: 'choose-qty' });
    expect(resolveStartOrder(true, 0)).toEqual({ kind: 'choose-qty' });
  });
});

describe('resolveAfterQty (из onChooseQty)', () => {
  it('адрес есть → confirm с тем же количеством', () => {
    expect(resolveAfterQty(3, true)).toEqual({ kind: 'confirm', bottles: 3 });
  });

  it('адреса нет → промпт адреса (первый заказ)', () => {
    expect(resolveAfterQty(3, false)).toEqual({ kind: 'address-prompt' });
  });

  it('количество прокидывается в intent как есть', () => {
    expect(resolveAfterQty(1, true)).toEqual({ kind: 'confirm', bottles: 1 });
    expect(resolveAfterQty(MAX_ORDER_QTY, true)).toEqual({
      kind: 'confirm',
      bottles: MAX_ORDER_QTY,
    });
  });
});

describe('resolveConfirm (из renderConfirm)', () => {
  it('bottles задано → confirm с этим количеством', () => {
    expect(resolveConfirm(2)).toEqual({ kind: 'confirm', bottles: 2 });
  });

  it('bottles не задано (undefined) → fallback на выбор количества', () => {
    expect(resolveConfirm(undefined)).toEqual({ kind: 'choose-qty' });
  });

  it('bottles === 0 → fallback на выбор количества (!bottles, как в исходнике)', () => {
    expect(resolveConfirm(0)).toEqual({ kind: 'choose-qty' });
  });
});

describe('resolveFinalizeAddress (из finalizeAddress)', () => {
  it('адрес введён → к выбору количества', () => {
    expect(resolveFinalizeAddress('Хмельницкого 2')).toEqual({
      kind: 'choose-qty',
    });
  });

  it('адреса нет (undefined) → вернуть к вводу адреса', () => {
    expect(resolveFinalizeAddress(undefined)).toEqual({
      kind: 'address-prompt',
    });
  });

  it('пустая строка → вернуть к вводу адреса (!raw, как в исходнике)', () => {
    expect(resolveFinalizeAddress('')).toEqual({ kind: 'address-prompt' });
  });
});
