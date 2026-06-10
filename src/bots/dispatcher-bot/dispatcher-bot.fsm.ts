/**
 * Чистая логика диспетчерского бота (SPEC §7). Без grammY/БД/сайд-эффектов —
 * сюда вынесено баго-опасное ветвление: маршрутизация текста по режимам ввода
 * (взаимоисключающие правка цены и правка количества) и разбор чисел с
 * границами. Данные грузит хендлер; сюда передаются уже готовые примитивы.
 */
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';

// Подписи reply-кнопок постоянного меню (они же — ключи текстового роутера).
export const BTN_ORDERS = '📋 Активные';
export const BTN_PRICES = '💰 Цены';
export const BTN_STATS = '📊 Статистика';

/** Намерение, к которому сводится входящий текст диспетчера. Исполнение — в хендлере. */
export type DispatcherTextIntent =
  | { kind: 'menu'; action: 'orders' | 'prices' | 'stats' }
  | { kind: 'edit-quantity'; orderId: string }
  | { kind: 'edit-price'; field: EditablePriceField }
  | { kind: 'ignore' };

/** Активный режим текстового ввода (часть сессии диспетчера). */
export interface DispatcherInputState {
  editingOrderId?: string;
  editingPriceField?: EditablePriceField;
}

/**
 * Решает, что означает присланный диспетчером текст (SPEC §7). Порядок ветвления
 * сохранён в точности: кнопки меню имеют приоритет (чтобы «💰 Цены» не ушло как
 * значение цены), затем правка количества заказа важнее правки цены (режимы
 * взаимоисключающие). Если ни кнопка, ни активный режим — текст игнорируется.
 */
export function routeDispatcherText(
  text: string,
  state: DispatcherInputState,
): DispatcherTextIntent {
  switch (text) {
    case BTN_ORDERS:
      return { kind: 'menu', action: 'orders' };
    case BTN_PRICES:
      return { kind: 'menu', action: 'prices' };
    case BTN_STATS:
      return { kind: 'menu', action: 'stats' };
    default:
      break;
  }
  if (state.editingOrderId) {
    return { kind: 'edit-quantity', orderId: state.editingOrderId };
  }
  if (state.editingPriceField) {
    return { kind: 'edit-price', field: state.editingPriceField };
  }
  return { kind: 'ignore' };
}

/** Результат разбора числа из текста: валидное значение или отказ. */
export type ParseResult = { ok: true; value: number } | { ok: false };

/**
 * Разбор количества бутылей при правке заказа (✏️ Изменить). Требуется целое
 * число в диапазоне [1, max]; иначе отказ (хендлер просит ввести заново).
 */
export function parseEditedQuantity(text: string, max: number): ParseResult {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Разбор нового значения цены (/prices). Требуется целое неотрицательное число
 * (0 допустим — напр. бесплатная доставка/помпа); иначе отказ.
 */
export function parsePriceValue(text: string): ParseResult {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}
