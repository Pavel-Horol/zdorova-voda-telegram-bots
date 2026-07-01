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
export const BTN_CLIENT = '🔎 Клієнт';

/** Intent the incoming dispatcher text reduces to. Execution — in the handler. */
export type DispatcherTextIntent =
  | { kind: 'menu'; action: 'orders' | 'prices' | 'stats' | 'client' }
  | { kind: 'edit-quantity'; orderId: string }
  | { kind: 'edit-claim'; orderId: string }
  | { kind: 'set-geo'; orderId: string }
  | { kind: 'lookup-client' }
  | { kind: 'edit-price'; field: EditablePriceField }
  | { kind: 'ignore' };

/** Active text input mode (part of the dispatcher session). Modes are exclusive. */
export interface DispatcherInputState {
  editingOrderId?: string;
  /** Correcting the self-declared bottle balance of an OWN_TARA order (step B). */
  editingClaimOrderId?: string;
  /** Attaching delivery coordinates to an order's address (geo-tagging). */
  geoTaggingOrderId?: string;
  /** Awaiting a phone number to look a client up (🔎 Клієнт). */
  lookupClient?: boolean;
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
    default:
      break;
  }
  if (state.editingOrderId) {
    return { kind: 'edit-quantity', orderId: state.editingOrderId };
  }
  if (state.editingClaimOrderId) {
    return { kind: 'edit-claim', orderId: state.editingClaimOrderId };
  }
  if (state.geoTaggingOrderId) {
    return { kind: 'set-geo', orderId: state.geoTaggingOrderId };
  }
  if (state.lookupClient) {
    return { kind: 'lookup-client' };
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
