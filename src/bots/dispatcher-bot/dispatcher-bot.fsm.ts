/**
 * Pure dispatcher bot logic (SPEC §7). No grammY/DB/side effects — the bug-prone
 * branching is moved here: routing text by input modes (mutually exclusive price
 * editing and quantity editing) and parsing numbers with bounds. The handler loads
 * the data; ready primitives are passed in here.
 */
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';
import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';

// Labels of the persistent menu reply buttons (also the keys of the text router).
export const BTN_ORDERS = '📋 Активні';
export const BTN_PRICES = '💰 Ціни';
export const BTN_STATS = '📊 Статистика';
export const BTN_CLIENT = '🔎 Клієнт';
export const BTN_CONTACTS = '📞 Контакти';

/**
 * Which field of an order the dispatcher chose to edit (✏️ Змінити → sub-menu):
 * bottle quantity, delivery address text or the address comment. Geo point and the
 * OWN_TARA claim have their own dedicated buttons on the card, not this menu.
 */
export type OrderEditField = 'qty' | 'addr' | 'comment';

/** Intent the incoming dispatcher text reduces to. Execution — in the handler. */
export type DispatcherTextIntent =
  | {
      kind: 'menu';
      action: 'orders' | 'prices' | 'stats' | 'client' | 'contacts';
    }
  | { kind: 'edit-order'; orderId: string; field: OrderEditField }
  | { kind: 'edit-claim'; orderId: string }
  | { kind: 'set-geo'; orderId: string }
  | { kind: 'set-delivery-note'; orderId: string }
  | { kind: 'lookup-client' }
  | { kind: 'lookup-order' }
  | { kind: 'add-contact' }
  | { kind: 'add-dispatcher' }
  | { kind: 'edit-price'; field: EditablePriceField }
  | { kind: 'ignore' };

/** Active text input mode (part of the dispatcher session). Modes are exclusive. */
export interface DispatcherInputState {
  /** The order + which field the dispatcher is editing (✏️ Змінити sub-menu). */
  editingOrder?: { id: string; field: OrderEditField };
  /** Correcting the self-declared bottle balance of an OWN_TARA order (step B). */
  editingClaimOrderId?: string;
  /** Attaching delivery coordinates to an order's address (geo-tagging). */
  geoTaggingOrderId?: string;
  /** Awaiting a custom delivery-timing message for the client (🕒 ✏️ Свій варіант). */
  deliveryNoteOrderId?: string;
  /** Awaiting a phone number to look a client up (🔎 Клієнт). */
  lookupClient?: boolean;
  /** Awaiting an order id to look an order up (/order). */
  lookupOrder?: boolean;
  /** Awaiting a new support phone to add to the contact list (📞 Контакти → ➕). */
  addingContact?: boolean;
  /** Awaiting a chat id (+ optional label) to add a dispatcher (/dispatchers → ➕). */
  addingDispatcher?: boolean;
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
    case BTN_CLIENT:
      return { kind: 'menu', action: 'client' };
    case BTN_CONTACTS:
      return { kind: 'menu', action: 'contacts' };
    default:
      break;
  }
  if (state.editingOrder) {
    return {
      kind: 'edit-order',
      orderId: state.editingOrder.id,
      field: state.editingOrder.field,
    };
  }
  if (state.editingClaimOrderId) {
    return { kind: 'edit-claim', orderId: state.editingClaimOrderId };
  }
  if (state.geoTaggingOrderId) {
    return { kind: 'set-geo', orderId: state.geoTaggingOrderId };
  }
  if (state.deliveryNoteOrderId) {
    return { kind: 'set-delivery-note', orderId: state.deliveryNoteOrderId };
  }
  if (state.lookupClient) {
    return { kind: 'lookup-client' };
  }
  if (state.lookupOrder) {
    return { kind: 'lookup-order' };
  }
  if (state.addingContact) {
    return { kind: 'add-contact' };
  }
  if (state.addingDispatcher) {
    return { kind: 'add-dispatcher' };
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

/**
 * Reduces a dispatcher-typed phone to a search token: digits only, the last up to 9
 * (the subscriber part, so `0501234567` / `+380501234567` / `501234567` all match a
 * stored `+380501234567` via a substring search). Too few digits (< 5) → null (the
 * handler asks again, avoids matching half the base). Pure — DB search is the handler's.
 */
export function phoneSearchToken(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5) return null;
  return digits.slice(-9);
}

/**
 * Normalizes the id argument of `/order <id>` for a read-only order lookup. The
 * dispatcher sees the short id `#a1b2c3d4` on a card and may paste it with or without
 * the leading `#`, or paste a full uuid. Strips a leading `#`, trims, lowercases and
 * validates that what remains is a plausible hex prefix (the order id is a uuid — hex
 * digits and dashes only). Rejects empty / too-short (< 4) / non-hex input → null, so
 * garbage never reaches the DB as a prefix search. Returns the clean prefix otherwise.
 */
export function normalizeOrderIdArg(raw: string): string | null {
  const text = raw.trim().replace(/^#/, '').trim().toLowerCase();
  if (text.length < 4) return null;
  // uuid alphabet only (hex + dashes) — a short id is 8 hex chars, a full uuid adds dashes.
  if (!/^[0-9a-f-]+$/.test(text)) return null;
  return text;
}

/** A parsed "add dispatcher" line: the Telegram chat id and an optional label. */
export type DispatcherInput = { chatId: string; label: string | null };

/**
 * Parses the super-admin's "add dispatcher" input: the first whitespace-delimited token
 * is the Telegram chat id (an integer, negative for group chats), the rest is an optional
 * free-text label. Rejects a non-integer id (null → the handler asks to re-enter), so a
 * mistyped id can't admit a wrong chat. The label is trimmed; empty → null.
 */
export function parseDispatcherInput(raw: string): DispatcherInput | null {
  const text = raw.trim();
  if (!text) return null;
  const sep = text.search(/\s/);
  const idPart = sep === -1 ? text : text.slice(0, sep);
  const labelPart = sep === -1 ? '' : text.slice(sep + 1).trim();
  if (!/^-?\d+$/.test(idPart)) return null;
  return { chatId: idPart, label: labelPart || null };
}

/** The subset of a Telegram getChat result we build a dispatcher label from. */
export interface ChatInfo {
  first_name?: string;
  last_name?: string;
  username?: string;
  /** Set for group / channel chats (private chats have first_name instead). */
  title?: string;
}

/**
 * Builds a human label from a getChat result (pure — unit-tested), so the super-admin
 * only types the chat id and the name is pulled automatically. A group/channel uses its
 * title; a private chat uses "First Last" (+ @username when present), or just @username,
 * or null when Telegram exposed nothing usable (the id alone is then shown in the list).
 */
export function formatChatTitle(chat: ChatInfo): string | null {
  if (chat.title?.trim()) return chat.title.trim();
  const name = [chat.first_name, chat.last_name]
    .filter((p): p is string => !!p?.trim())
    .join(' ')
    .trim();
  if (name) return chat.username ? `${name} (@${chat.username})` : name;
  if (chat.username?.trim()) return `@${chat.username.trim()}`;
  return null;
}

/** Parsed geo coordinates, or null when the text is not recognised. */
export type GeoCoords = { lat: number; lng: number };

/**
 * Validates a lat/lng pair and rejects out-of-range / non-finite values. Shared by
 * every {@link parseGeoInput} branch so a malformed link cannot yield a bad point.
 */
function toCoords(latRaw: string, lngRaw: string): GeoCoords | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Extracts delivery coordinates from what the dispatcher pasted: plain "lat, lng",
 * a Google Maps link (`@lat,lng` / `q=` / `ll=`) or an OpenStreetMap link
 * (`#map=z/lat/lng` / `mlat=&mlon=`). Returns null if nothing parseable is found
 * (the handler asks to re-send). Native Telegram location pins do not go through
 * here — the location handler reads them directly. Shortened links (maps.app.goo.gl)
 * carry no coordinates in the URL and are intentionally not resolved.
 */
export function parseGeoInput(raw: string): GeoCoords | null {
  const text = raw.trim();
  // OpenStreetMap marker (?mlat=..&mlon=..)
  let m = text.match(
    /[?&]mlat=(-?\d+(?:\.\d+)?)\b[\s\S]*?[?&]mlon=(-?\d+(?:\.\d+)?)/,
  );
  if (m) return toCoords(m[1], m[2]);
  // OpenStreetMap view (#map=zoom/lat/lng)
  m = text.match(/#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
  if (m) return toCoords(m[1], m[2]);
  // Google Maps (@lat,lng / q=lat,lng / ll=lat,lng)
  m = text.match(/[@=](-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (m) return toCoords(m[1], m[2]);
  // Plain "lat, lng"
  m = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) return toCoords(m[1], m[2]);
  return null;
}

/**
 * If more than this many orders are active, /orders resends the full actionable
 * cards ONLY for the unhandled (CREATED) ones — the rest stay in the summary above,
 * so the queue does not flood the chat (the whole point of the summary view).
 */
export const ACTIVE_CARDS_CAP = 10;

/**
 * Minimal order shape the queue logic needs — the fields that decide ordering and the
 * one-liner. Deliberately narrow so the sort/format helpers stay pure and easy to test
 * (the handler passes the full {@link OrderWithRelations}, which structurally matches).
 */
export interface QueueOrder {
  id: string;
  status: OrderStatus;
  kind: OrderKind;
  createdAt: Date;
}

/**
 * Formats how long ago `from` was, relative to `now` (both passed in — NO Date.now()
 * here, so tests are deterministic). Buckets: under a minute → «щойно», then whole
 * minutes «N хв», hours «N год», days «N дн». A future/equal instant clamps to «щойно».
 */
export function formatAge(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'щойно';
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} год`;
  const days = Math.floor(hours / 24);
  return `${days} дн`;
}

/**
 * Orders the active queue for the dispatcher: unhandled first (CREATED before ACCEPTED),
 * and within each status the oldest `createdAt` first (FIFO — the longest-waiting order
 * is handled first). Pure and stable; does not mutate the input array.
 */
export function sortActiveQueue<T extends QueueOrder>(
  orders: readonly T[],
): T[] {
  const rank = (s: OrderStatus): number => (s === OrderStatus.CREATED ? 0 : 1);
  return [...orders].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Short kind mark for the one-liner (mirrors the fuller marks on the card). */
function queueKindMark(kind: OrderKind): string {
  switch (kind) {
    case OrderKind.OWN_TARA:
      return 'своя тара';
    case OrderKind.STARTER_KIT:
      return 'перше';
    default:
      return 'обмін';
  }
}

/** Status icon for the one-liner: 🆕 unhandled (CREATED), ✅ in progress (ACCEPTED). */
function queueStatusIcon(status: OrderStatus): string {
  return status === OrderStatus.CREATED ? '🆕' : '✅';
}

/**
 * One-liner for an order in the summary list: status icon, short id, kind mark and age
 * (e.g. «🆕 #a1b2c3d4 · своя тара · 42 хв»). Pure — `now` decides the age.
 */
export function formatQueueLine(order: QueueOrder, now: Date): string {
  const icon = queueStatusIcon(order.status);
  const id = `#${order.id.slice(0, 8)}`;
  const mark = queueKindMark(order.kind);
  const age = formatAge(order.createdAt, now);
  return `${icon} ${id} · ${mark} · ${age}`;
}

/** Split of the active queue into counts + the age of the oldest unhandled order. */
export interface QueueSummary {
  total: number;
  created: number;
  accepted: number;
  /** Age of the oldest CREATED (unhandled) order, or null when none are unhandled. */
  oldestCreated: QueueOrder | null;
}

/**
 * Reduces the (already sorted) queue to its summary counts + the oldest unhandled order.
 * Expects the queue in {@link sortActiveQueue} order, so the first CREATED is the oldest.
 */
export function summarizeQueue(sorted: readonly QueueOrder[]): QueueSummary {
  let created = 0;
  let accepted = 0;
  let oldestCreated: QueueOrder | null = null;
  for (const o of sorted) {
    if (o.status === OrderStatus.CREATED) {
      created += 1;
      if (!oldestCreated) oldestCreated = o;
    } else {
      accepted += 1;
    }
  }
  return { total: sorted.length, created, accepted, oldestCreated };
}
