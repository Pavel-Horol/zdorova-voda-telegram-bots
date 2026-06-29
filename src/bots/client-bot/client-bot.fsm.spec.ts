import {
  MAX_ORDER_QTY,
  parseEditField,
  parseOnboardingChoice,
  parsePumpChoice,
  parseQty,
  parseTaraCount,
  parseYesNo,
  resolveAfterQty,
  resolveBack,
  resolveConfirm,
  resolveFinalizeAddress,
  resolveStartOrder,
  Step,
} from './client-bot.fsm';

/**
 * Characterization tests for "Back" (former onBack): pin the CURRENT branching
 * behaviour by the step popped off the stack. The table mirrors every branch of the
 * original handler, including the defensive one (empty stack) and the address-dependent one.
 */
describe('resolveBack', () => {
  it('empty stack (prev === undefined) → main menu', () => {
    expect(resolveBack(undefined, false)).toBe('main-menu');
    expect(resolveBack(undefined, true)).toBe('main-menu');
  });

  it('prev === MainMenu → main menu', () => {
    expect(resolveBack(Step.MainMenu, false)).toBe('main-menu');
  });

  it('prev === AwaitAddress → address prompt', () => {
    expect(resolveBack(Step.AwaitAddress, true)).toBe('address-prompt');
  });

  it('prev === AwaitComment → comment prompt', () => {
    expect(resolveBack(Step.AwaitComment, true)).toBe('comment-prompt');
  });

  describe('prev === ChooseQty (depends on whether an address exists)', () => {
    it('address exists → quantity selection', () => {
      expect(resolveBack(Step.ChooseQty, true)).toBe('choose-qty');
    });

    it('no address → back to address input', () => {
      expect(resolveBack(Step.ChooseQty, false)).toBe('address-prompt');
    });
  });

  it('the address matters only for the quantity branch, the rest ignore it', () => {
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
 * Characterization tests for quantity validation (former inline logic of onChooseQty):
 * pin the CURRENT behaviour for valid, boundary, and forged callback values. Previously
 * invalid input led to a silent `return` in the handler — here it is `null` (the handler
 * on `null` also exits without action).
 */
describe('parseQty', () => {
  it('valid quantity in the range 1..MAX_ORDER_QTY → the number itself', () => {
    expect(parseQty('1')).toBe(1);
    expect(parseQty('3')).toBe(3);
    expect(parseQty('5')).toBe(5);
  });

  it('boundary MAX_ORDER_QTY inclusive → number', () => {
    expect(parseQty(String(MAX_ORDER_QTY))).toBe(MAX_ORDER_QTY);
  });

  it('exceeding MAX_ORDER_QTY (forged callback) → null', () => {
    expect(parseQty(String(MAX_ORDER_QTY + 1))).toBeNull();
    expect(parseQty('1000')).toBeNull();
  });

  it('value less than 1 → null', () => {
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-5')).toBeNull();
  });

  it('non-integer number → null', () => {
    expect(parseQty('2.5')).toBeNull();
  });

  it('not a number → null', () => {
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('')).toBeNull();
    expect(parseQty('3a')).toBeNull();
  });
});

/**
 * Unit tests for the transitions moved out of the handlers (onChooseQty /
 * finalizeAddress / renderConfirm). Behaviour is identical to the original service branches.
 */
describe('resolveStartOrder (from startOrder)', () => {
  it('new client (needsOnboarding) → onboarding screen, before all branches', () => {
    expect(resolveStartOrder(false, null, true)).toEqual({
      kind: 'onboarding',
    });
    // even with an address/previous order, onboarding has priority
    expect(resolveStartOrder(true, 3, true)).toEqual({ kind: 'onboarding' });
  });

  it('no address → address prompt (first order)', () => {
    expect(resolveStartOrder(false, null, false)).toEqual({
      kind: 'address-prompt',
    });
    expect(resolveStartOrder(false, 3, false)).toEqual({
      kind: 'address-prompt',
    });
  });

  it('address exists and there was a previous order → confirm with the previous quantity (one-tap repeat)', () => {
    expect(resolveStartOrder(true, 3, false)).toEqual({
      kind: 'confirm',
      bottles: 3,
    });
    expect(resolveStartOrder(true, MAX_ORDER_QTY, false)).toEqual({
      kind: 'confirm',
      bottles: MAX_ORDER_QTY,
    });
  });

  it('address exists, no orders yet (null/0) → quantity selection', () => {
    expect(resolveStartOrder(true, null, false)).toEqual({
      kind: 'choose-qty',
    });
    expect(resolveStartOrder(true, 0, false)).toEqual({ kind: 'choose-qty' });
  });
});

describe('parseOnboardingChoice', () => {
  it('valid variants → themselves', () => {
    expect(parseOnboardingChoice('kit')).toBe('kit');
    expect(parseOnboardingChoice('own')).toBe('own');
    expect(parseOnboardingChoice('other')).toBe('other');
  });

  it('the merged-away "existing" variant is no longer accepted', () => {
    expect(parseOnboardingChoice('existing')).toBeNull();
  });

  it('foreign/forged variant → null', () => {
    expect(parseOnboardingChoice('admin')).toBeNull();
    expect(parseOnboardingChoice('')).toBeNull();
  });
});

describe('parseTaraCount', () => {
  it('integer 1..MAX_ORDER_QTY → number', () => {
    expect(parseTaraCount('1')).toBe(1);
    expect(parseTaraCount('5')).toBe(5);
    expect(parseTaraCount(String(MAX_ORDER_QTY))).toBe(MAX_ORDER_QTY);
  });

  it('out of bounds / not a number → null', () => {
    expect(parseTaraCount('0')).toBeNull();
    expect(parseTaraCount('-2')).toBeNull();
    expect(parseTaraCount('2.5')).toBeNull();
    expect(parseTaraCount(String(MAX_ORDER_QTY + 1))).toBeNull();
    expect(parseTaraCount('abc')).toBeNull();
  });
});

describe('parsePumpChoice', () => {
  it('std/electro → themselves', () => {
    expect(parsePumpChoice('std')).toBe('std');
    expect(parsePumpChoice('electro')).toBe('electro');
  });

  it('foreign → null', () => {
    expect(parsePumpChoice('gold')).toBeNull();
    expect(parsePumpChoice('')).toBeNull();
  });
});

describe('parseYesNo', () => {
  it('yes → true, no → false', () => {
    expect(parseYesNo('yes')).toBe(true);
    expect(parseYesNo('no')).toBe(false);
  });

  it('foreign → null', () => {
    expect(parseYesNo('maybe')).toBeNull();
    expect(parseYesNo('')).toBeNull();
  });
});

describe('parseEditField', () => {
  it('valid fields → themselves', () => {
    expect(parseEditField('qty')).toBe('qty');
    expect(parseEditField('addr')).toBe('addr');
    expect(parseEditField('comment')).toBe('comment');
    expect(parseEditField('pump')).toBe('pump');
  });

  it('foreign/forged field → null', () => {
    expect(parseEditField('price')).toBeNull();
    expect(parseEditField('')).toBeNull();
  });
});

describe('resolveAfterQty (from onChooseQty)', () => {
  it('address exists → confirm with the same quantity', () => {
    expect(resolveAfterQty(3, true)).toEqual({ kind: 'confirm', bottles: 3 });
  });

  it('no address → address prompt (first order)', () => {
    expect(resolveAfterQty(3, false)).toEqual({ kind: 'address-prompt' });
  });

  it('the quantity is passed into the intent as is', () => {
    expect(resolveAfterQty(1, true)).toEqual({ kind: 'confirm', bottles: 1 });
    expect(resolveAfterQty(MAX_ORDER_QTY, true)).toEqual({
      kind: 'confirm',
      bottles: MAX_ORDER_QTY,
    });
  });
});

describe('resolveConfirm (from renderConfirm)', () => {
  it('bottles set → confirm with this quantity', () => {
    expect(resolveConfirm(2)).toEqual({ kind: 'confirm', bottles: 2 });
  });

  it('bottles not set (undefined) → fallback to quantity selection', () => {
    expect(resolveConfirm(undefined)).toEqual({ kind: 'choose-qty' });
  });

  it('bottles === 0 → fallback to quantity selection (!bottles, as in the original)', () => {
    expect(resolveConfirm(0)).toEqual({ kind: 'choose-qty' });
  });
});

describe('resolveFinalizeAddress (from finalizeAddress)', () => {
  it('address entered → to quantity selection', () => {
    expect(resolveFinalizeAddress('Khmelnytskoho 2')).toEqual({
      kind: 'choose-qty',
    });
  });

  it('no address (undefined) → return to address input', () => {
    expect(resolveFinalizeAddress(undefined)).toEqual({
      kind: 'address-prompt',
    });
  });

  it('empty string → return to address input (!raw, as in the original)', () => {
    expect(resolveFinalizeAddress('')).toEqual({ kind: 'address-prompt' });
  });
});
