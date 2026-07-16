/**
 * Pure client bot FSM logic (SPEC §6). No grammY/DB/side effects — the bug-prone
 * branching is moved here so it can be covered by unit tests.
 */

/** Client dialog steps (SPEC §6). Stored in grammY's in-memory session. */
export enum Step {
  AwaitContact = 'AWAIT_CONTACT',
  MainMenu = 'MAIN_MENU',
  Onboarding = 'ONBOARDING',
  PumpChoice = 'PUMP_CHOICE',
  OwnTaraCount = 'OWN_TARA_COUNT',
  OwnPumpAsk = 'OWN_PUMP_ASK',
  AwaitAddress = 'AWAIT_ADDRESS',
  AwaitComment = 'AWAIT_COMMENT',
  ChooseQty = 'CHOOSE_QTY',
  Confirm = 'CONFIRM',
  EditMenu = 'EDIT_MENU',
  /** Awaiting the optional client note about this order (from Confirm). */
  AwaitOrderNote = 'AWAIT_ORDER_NOTE',
}

/**
 * Choice on the new-client onboarding screen (PRODUCT.md). Two real states only:
 * `kit` (nothing yet → starter kit) and `own` (already has bottles — own or another
 * brand's, which we re-label as ours: identical pricing, deposit 0). `other` →
 * dispatcher callback. The former separate "I am already your client" branch was
 * merged into `own` (same OWN_TARA flow; verification handled on the order).
 */
export type OnboardingChoice = 'kit' | 'own' | 'other';

/**
 * Parses the onboarding choice from `callback_data` (`ob:<choice>`). Input is
 * untrusted — a foreign value → null (the handler exits without action).
 */
export function parseOnboardingChoice(raw: string): OnboardingChoice | null {
  switch (raw) {
    case 'kit':
    case 'own':
    case 'other':
      return raw;
    default:
      return null;
  }
}

/**
 * Parses the number of own bottles (OWN_TARA) from text. An integer `1..MAX_ORDER_QTY`
 * or null (not a number / out of bounds) — untrusted input, like {@link parseQty}.
 */
export function parseTaraCount(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  if (n > MAX_ORDER_QTY) return null;
  return n;
}

/**
 * Parses the own-bottles count choice from `callback_data` (`tara:<n>|more`). A digit
 * button gives the count (validated like {@link parseTaraCount}); `more` means the
 * client wants to type an arbitrary number. Untrusted input → null.
 */
export function parseTaraChoice(raw: string): number | 'more' | null {
  if (raw === 'more') return 'more';
  return parseTaraCount(raw);
}

/** Pump choice in the starter kit (STEP3 T5). */
export type PumpChoice = 'std' | 'electro';

/** Parses the pump choice from `callback_data` (`pump:std|electro`). */
export function parsePumpChoice(raw: string): PumpChoice | null {
  return raw === 'std' || raw === 'electro' ? raw : null;
}

/** Parses a yes/no answer (`yn:yes|no`) — e.g. "do you have a pump?". */
export function parseYesNo(raw: string): boolean | null {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return null;
}

/** Field the client picks to change on the confirmation edit menu (✏️ Змінити). */
export type EditField = 'qty' | 'addr' | 'comment' | 'pump';

/**
 * Parses the edit-menu choice from `callback_data` (`ed:<field>`). Untrusted input —
 * a foreign value → null (the handler exits without action). `pump` is only offered
 * for the starter kit, but parsing it is harmless for other kinds (electro is then ignored).
 */
export function parseEditField(raw: string): EditField | null {
  switch (raw) {
    case 'qty':
    case 'addr':
    case 'comment':
    case 'pump':
      return raw;
    default:
      return null;
  }
}

/**
 * Upper bound on the order size. Buttons offer at most MAX_QTY (or a repeat of an
 * actual previous order), so anything larger is a forged callback. Protects against
 * absurd totals; real large orders go via a call to the dispatcher (SPEC §1, §7).
 */
export const MAX_ORDER_QTY = 100;

/**
 * Parses and validates the bottle quantity from `callback_data` (`qty:N`). Input is
 * untrusted (SPEC §7): a callback can be forged around the UI. Returns an integer
 * `1..MAX_ORDER_QTY` or `null` if the value is not a number, less than 1, or exceeds
 * the limit. Pure: no ctx, no services — decide here, execute in the handler.
 */
export function parseQty(raw: string): number | null {
  const bottles = Number(raw);
  if (!Number.isInteger(bottles) || bottles < 1) return null;
  if (bottles > MAX_ORDER_QTY) return null;
  return bottles;
}

// ===========================================================================
// Declarative FSM skeleton (SPEC §6). ONLY the screen dictionary and the pure
// transition signatures. The transition logic still lives in client-bot.service.ts —
// moving it on top of this dictionary is a separate step. No grammY/DB/side effects here.
// ===========================================================================

/**
 * The screen a FSM transition leads to, + the data to render it (if the screen
 * needs any). A discriminated union by `kind` — the single "exit" of all pure
 * transition functions. The transitions DECIDE which screen to show; EXECUTION
 * (sending the message, stripping keyboards, async-loading preview/repeat) is on
 * the handler's side. Therefore data that requires a DB trip (price preview on
 * confirm, repeatN on choose-qty) is NOT put here — the handler loads it at render time.
 *
 * Coverage of the current flow (PRODUCT.md "Client bot behaviour"):
 * - `await-contact`   — /start of a new client: no contact, no progress.
 * - `main-menu`        — known client / exit from the scenario; `name` for the greeting.
 * - `address-prompt`   — first order or no default address: ask for the address.
 * - `comment-prompt`   — after the address: floor/intercom (can "Skip").
 * - `choose-qty`       — quantity selection (+ "Repeat last order").
 * - `confirm`          — price preview and confirmation; `bottles` — chosen quantity.
 * - `order-done`       — order created: "Order accepted, please wait".
 */
export type ScreenIntent =
  | { kind: 'await-contact' }
  | { kind: 'main-menu'; name: string | null }
  | { kind: 'onboarding' }
  | { kind: 'pump-choice' }
  | { kind: 'own-tara-count' }
  | { kind: 'own-pump-ask' }
  | { kind: 'address-prompt' }
  | { kind: 'comment-prompt' }
  | { kind: 'choose-qty' }
  | { kind: 'confirm'; bottles: number }
  | { kind: 'order-done' };

/** All valid screen `kind`s — for type-safe subsets (see BackTarget). */
export type ScreenKind = ScreenIntent['kind'];

/**
 * The screen the "Back" button leads to. A subset of {@link ScreenKind}: back can
 * only return to order-scenario screens (not confirm/order-done/await-contact).
 * Tied to the dictionary via `Extract` — removing a kind from ScreenIntent breaks
 * this spot at compile time.
 */
export type BackTarget = Extract<
  ScreenKind,
  'main-menu' | 'address-prompt' | 'comment-prompt' | 'choose-qty'
>;

/**
 * The "Back" button decision: by the step popped off the history stack (`prev`) and
 * whether a saved address exists, picks the screen. Pure: the handler loads the data
 * and passes `hasDefaultAddress` in ready (it only matters for the quantity branch).
 *
 * - empty stack or returning to the main menu → main menu;
 * - address/comment → the corresponding prompt;
 * - otherwise (quantity selection): to quantity selection, but if there is no
 *   address — back to address input.
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

// --- Pure transition functions ---------------------------------------------
// Each: in — step/validated input/ALREADY loaded data, out — a ScreenIntent. No
// async or services: the handler loads the data (address, preview, repeatN) and
// passes it in ready; execution (render, stripping keyboards, writing the session)
// is also in the handler. Here is only the DECISION "which screen".

/**
 * Transition on entering the order scenario ("Order water", from `startOrder`). In —
 * whether a default address exists and the quantity of the last non-cancelled order
 * (the handler loads it). Decides:
 * - no address → collect the address (first order);
 * - address and a previous order → straight to confirmation with the previous quantity
 *   (one-tap repeat; "Edit" leads to quantity selection);
 * - address but no orders yet → quantity selection.
 * `!lastBottles` catches both `null` and `0`.
 */
export function resolveStartOrder(
  hasDefaultAddress: boolean,
  lastBottles: number | null,
  needsOnboarding: boolean,
): Extract<
  ScreenIntent,
  { kind: 'onboarding' | 'address-prompt' | 'choose-qty' | 'confirm' }
> {
  if (needsOnboarding) return { kind: 'onboarding' };
  if (!hasDefaultAddress) return { kind: 'address-prompt' };
  if (!lastBottles) return { kind: 'choose-qty' };
  return { kind: 'confirm', bottles: lastBottles };
}

/**
 * Transition after quantity selection (from `onChooseQty`). In — the validated
 * `bottles` (see {@link parseQty}) and whether a default address exists. Decides:
 * no address → collect the address (first order); has one → to confirmation with this quantity.
 */
export function resolveAfterQty(
  bottles: number,
  hasDefaultAddress: boolean,
): Extract<ScreenIntent, { kind: 'address-prompt' | 'confirm' }> {
  if (!hasDefaultAddress) return { kind: 'address-prompt' };
  return { kind: 'confirm', bottles };
}

/**
 * Transition to the confirmation screen (from `renderConfirm`). In — the quantity
 * from the session (may be unset on a desync). Decides: has `bottles` → confirm;
 * none → fallback to quantity selection. `!bottles` (as in the original) catches
 * both `undefined` and `0`.
 */
export function resolveConfirm(
  bottles: number | undefined,
): Extract<ScreenIntent, { kind: 'choose-qty' | 'confirm' }> {
  if (!bottles) return { kind: 'choose-qty' };
  return { kind: 'confirm', bottles };
}

/**
 * Transition after collecting the address (from `finalizeAddress`). In — `addressRaw`
 * from the session (creating/upserting the address stays in the handler). Decides:
 * no address → return to address input; has one → to quantity selection. `!addressRaw`
 * catches both `undefined` and the empty string (as in the original).
 */
export function resolveFinalizeAddress(
  addressRaw: string | undefined,
): Extract<ScreenIntent, { kind: 'address-prompt' | 'choose-qty' }> {
  if (!addressRaw) return { kind: 'address-prompt' };
  return { kind: 'choose-qty' };
}

/**
 * Marker of an unreachable branch for exhaustive `switch`. If `x` is not statically
 * narrowed to `never` (i.e. an unhandled variant appeared — e.g. a new kind in
 * {@link ScreenIntent}), the call stops compiling. We reach it at runtime only on a
 * type mismatch — then we throw with diagnostics.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
