/**
 * Чистая логика FSM клиентского бота (SPEC §6). Без grammY/БД/сайд-эффектов —
 * сюда выносится баго-опасное ветвление, чтобы покрыть его юнит-тестами.
 */

/** Шаги диалога клиента (SPEC §6). Хранятся в in-memory сессии grammY. */
export enum Step {
  AwaitContact = 'AWAIT_CONTACT',
  MainMenu = 'MAIN_MENU',
  AwaitAddress = 'AWAIT_ADDRESS',
  AwaitComment = 'AWAIT_COMMENT',
  ChooseQty = 'CHOOSE_QTY',
  Confirm = 'CONFIRM',
}

/** Экран, на который ведёт кнопка «Назад». Исполнение — на стороне хендлера. */
export type BackTarget =
  | 'main-menu'
  | 'address-prompt'
  | 'comment-prompt'
  | 'choose-qty';

/**
 * Решение кнопки «Назад»: по снятому со стека истории шагу (`prev`) и наличию
 * сохранённого адреса выбирает экран. Чистая: данные грузит хендлер и передаёт
 * сюда `hasDefaultAddress` уже готовым (важно лишь для ветки выбора количества).
 *
 * - пустой стек или возврат в главное меню → главное меню;
 * - адрес/комментарий → соответствующий промпт;
 * - иначе (выбор количества): к выбору количества, но если адреса нет —
 *   обратно к вводу адреса.
 */
export function resolveBack(
  prev: Step | undefined,
  hasDefaultAddress: boolean,
): BackTarget {
  if (!prev || prev === Step.MainMenu) return 'main-menu';
  if (prev === Step.AwaitAddress) return 'address-prompt';
  if (prev === Step.AwaitComment) return 'comment-prompt';
  return hasDefaultAddress ? 'choose-qty' : 'address-prompt';
}
