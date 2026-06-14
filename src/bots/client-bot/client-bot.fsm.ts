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

/**
 * Верхняя граница объёма заказа. Кнопки дают максимум MAX_QTY (или повтор
 * реального прошлого заказа), так что больше — это подделанный callback. Защита
 * от абсурдных сумм; реальные большие заказы — звонком диспетчеру (SPEC §1, §7).
 */
export const MAX_ORDER_QTY = 100;

/**
 * Парсит и валидирует количество бутылей из `callback_data` (`qty:N`). Вход
 * недоверенный (SPEC §7): callback можно подделать в обход UI. Возвращает целое
 * `1..MAX_ORDER_QTY` либо `null`, если значение не число, меньше 1 или превышает
 * лимит. Чистая: ни ctx, ни сервисов — решение, исполнение в хендлере.
 */
export function parseQty(raw: string): number | null {
  const bottles = Number(raw);
  if (!Number.isInteger(bottles) || bottles < 1) return null;
  if (bottles > MAX_ORDER_QTY) return null;
  return bottles;
}

// ===========================================================================
// Декларативный каркас FSM (SPEC §6). ТОЛЬКО словарь экранов и сигнатуры чистых
// переходов. Логика переходов пока живёт в client-bot.service.ts — перенос будет
// отдельным шагом поверх этого словаря. Здесь нет grammY/БД/сайд-эффектов.
// ===========================================================================

/**
 * Экран, на который ведёт переход FSM, + данные для его рендера (если экрану
 * нужны). Дискриминированный юнион по `kind` — единый «выход» всех чистых
 * функций-переходов. Сами переходы РЕШАЮТ, какой экран показать; ИСПОЛНЕНИЕ
 * (отправка сообщения, гашение клавиатур, async-загрузка превью/повтора) — на
 * стороне хендлера. Поэтому данные, требующие похода в БД (цена-превью на
 * confirm, repeatN на choose-qty), сюда НЕ кладём — их грузит хендлер при рендере.
 *
 * Покрытие текущего флоу (PRODUCT.md «Поведение клиентского бота»):
 * - `await-contact`   — /start нового клиента: без контакта дальше не пускаем.
 * - `main-menu`        — известный клиент / выход из сценария; `name` для приветствия.
 * - `address-prompt`   — первый заказ или нет default-адреса: просим адрес.
 * - `comment-prompt`   — после адреса: этаж/домофон (можно «Пропустить»).
 * - `choose-qty`       — выбор количества (+ «Повторить прошлый заказ»).
 * - `confirm`          — превью суммы и подтверждение; `bottles` — выбранное кол-во.
 * - `order-done`       — заказ создан: «Заказ принят, ожидайте».
 */
export type ScreenIntent =
  | { kind: 'await-contact' }
  | { kind: 'main-menu'; name: string | null }
  | { kind: 'address-prompt' }
  | { kind: 'comment-prompt' }
  | { kind: 'choose-qty' }
  | { kind: 'confirm'; bottles: number }
  | { kind: 'order-done' };

/** Все допустимые `kind` экранов — для типобезопасных подмножеств (см. BackTarget). */
export type ScreenKind = ScreenIntent['kind'];

/**
 * Экран, на который ведёт кнопка «Назад». Подмножество {@link ScreenKind}: назад
 * можно вернуться только на экраны сценария заказа (не на confirm/order-done/
 * await-contact). Через `Extract` связано со словарём — удаление kind из
 * ScreenIntent сломает это место на этапе компиляции.
 */
export type BackTarget = Extract<
  ScreenKind,
  'main-menu' | 'address-prompt' | 'comment-prompt' | 'choose-qty'
>;

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

// --- Чистые функции-переходы -----------------------------------------------
// Каждая: на вход — step/валидированный ввод/УЖЕ загруженные данные, на выход —
// ScreenIntent. Async и сервисы НЕ тащим: данные грузит хендлер (адрес, превью,
// repeatN), сюда приходят готовыми; исполнение (рендер, гашение клавиатур,
// запись сессии) — тоже в хендлере. Здесь только РЕШЕНИЕ «какой экран».

/**
 * Переход после выбора количества (из `onChooseQty`). На вход — валидированное
 * `bottles` (см. {@link parseQty}) и признак наличия default-адреса. Решает:
 * адреса нет → собрать адрес (первый заказ); есть → к подтверждению с этим кол-вом.
 */
export function resolveAfterQty(
  bottles: number,
  hasDefaultAddress: boolean,
): Extract<ScreenIntent, { kind: 'address-prompt' | 'confirm' }> {
  if (!hasDefaultAddress) return { kind: 'address-prompt' };
  return { kind: 'confirm', bottles };
}

/**
 * Переход на экран подтверждения (из `renderConfirm`). На вход — количество из
 * сессии (может быть не задано при рассинхроне). Решает: есть `bottles` →
 * confirm; нет → fallback на выбор количества. `!bottles` (как в исходнике)
 * ловит и `undefined`, и `0`.
 */
export function resolveConfirm(
  bottles: number | undefined,
): Extract<ScreenIntent, { kind: 'choose-qty' | 'confirm' }> {
  if (!bottles) return { kind: 'choose-qty' };
  return { kind: 'confirm', bottles };
}

/**
 * Переход после сбора адреса (из `finalizeAddress`). На вход — `addressRaw` из
 * сессии (создание/upsert адреса остаётся в хендлере). Решает: адреса нет →
 * вернуть к вводу адреса; есть → к выбору количества. `!addressRaw` ловит и
 * `undefined`, и пустую строку (как в исходнике).
 */
export function resolveFinalizeAddress(
  addressRaw: string | undefined,
): Extract<ScreenIntent, { kind: 'address-prompt' | 'choose-qty' }> {
  if (!addressRaw) return { kind: 'address-prompt' };
  return { kind: 'choose-qty' };
}

/**
 * Маркер недостижимой ветки для исчерпывающих `switch`. Если статически `x` не
 * сузился до `never` (т.е. появился необработанный вариант — напр. новый kind в
 * {@link ScreenIntent}), вызов перестанет компилироваться. В рантайм попадаем
 * только при рассогласовании типов — тогда бросаем с диагностикой.
 */
export function assertNever(x: never): never {
  throw new Error(`Необработанный вариант: ${JSON.stringify(x)}`);
}
