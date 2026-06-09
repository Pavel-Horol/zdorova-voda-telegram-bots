import { resolveBack, Step } from './client-bot.fsm';

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
