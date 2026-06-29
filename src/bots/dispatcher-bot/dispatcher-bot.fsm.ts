/**
 * Pure dispatcher bot logic (SPEC §7). No grammY/DB/side effects — the bug-prone
 * branching is moved here: routing text by input modes (mutually exclusive price
 * editing and quantity editing) and parsing numbers with bounds. The handler loads
 * the data; ready primitives are passed in here.
 */
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';

// Labels of the persistent menu reply buttons (also the keys of the text router).
export const BTN_ORDERS = '📋 Активні';
export const BTN_PRICES = '💰 Ціни';
export const BTN_STATS = '📊 Статистика';

/** Intent the incoming dispatcher text reduces to. Execution — in the handler. */
export type DispatcherTextIntent =
  | { kind: 'menu'; action: 'orders' | 'prices' | 'stats' }
  | { kind: 'edit-quantity'; orderId: string }
  | { kind: 'edit-claim'; orderId: string }
  | { kind: 'edit-price'; field: EditablePriceField }
  | { kind: 'ignore' };

/** Active text input mode (part of the dispatcher session). Modes are exclusive. */
export interface DispatcherInputState {
  editingOrderId?: string;
  /** Correcting the self-declared bottle balance of an OWN_TARA order (step B). */
  editingClaimOrderId?: string;
  editingPriceField?: EditablePriceField;
}

/**
 * Decides what the text sent by the dispatcher means (SPEC §7). The branching
 * order is preserved exactly: menu buttons take priority (so "💰 Ціни" is not sent
 * as a price value), then the order-editing modes (quantity / claim correction) win
 * over price editing. The modes are mutually exclusive (handlers clear the others on
 * entry). If neither a button nor an active mode — the text is ignored.
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
  if (state.editingClaimOrderId) {
    return { kind: 'edit-claim', orderId: state.editingClaimOrderId };
  }
  if (state.editingPriceField) {
    return { kind: 'edit-price', field: state.editingPriceField };
  }
  return { kind: 'ignore' };
}

/** Result of parsing a number from text: a valid value or a rejection. */
export type ParseResult = { ok: true; value: number } | { ok: false };

/**
 * Parses the bottle quantity when editing an order (✏️ Edit). Requires an integer
 * in the range [1, max]; otherwise reject (the handler asks to re-enter).
 */
export function parseEditedQuantity(text: string, max: number): ParseResult {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Parses a new price value (/prices). Requires a non-negative integer
 * (0 is allowed — e.g. free delivery/pump); otherwise reject.
 */
export function parsePriceValue(text: string): ParseResult {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}
