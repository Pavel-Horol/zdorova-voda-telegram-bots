import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context, type SessionFlavor } from 'grammy';
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';
import type { OrderEditField } from './dispatcher-bot.fsm';

/** DI token for the shared dispatcher bot instance. */
export const DISPATCHER_BOT = Symbol('DISPATCHER_BOT');

/**
 * The super-admin dispatcher chat id from env (DISPATCHER_CHAT_ID). It is always
 * admitted and always notified, and is the only chat allowed to manage the dispatcher
 * list (/dispatchers). Additional dispatchers live in the DB (DispatchersService) — the
 * full allowed set is env-admin ∪ active rows (see DispatchersService.allowedChatIds).
 */
export function superAdminChatId(config: ConfigService): string | undefined {
  return config.get<string>('DISPATCHER_CHAT_ID')?.trim() || undefined;
}

/**
 * Dispatcher session. Two mutually exclusive text input modes:
 * price editing (/prices) and quantity editing in an order (✏️).
 */
export interface DispatcherSession {
  editingPriceField?: EditablePriceField;
  /** The order + field we are awaiting new input for (✏️ Edit sub-menu flow). */
  editingOrder?: { id: string; field: OrderEditField };
  /** id of the OWN_TARA order we are awaiting a corrected declared balance for (step B). */
  editingClaimOrderId?: string;
  /** id of the order we are awaiting delivery coordinates for (📍 geo-tagging). */
  geoTaggingOrderId?: string;
  /** id of the order we are awaiting a custom delivery-timing message for (🕒). */
  deliveryNoteOrderId?: string;
  /** awaiting a phone number to look a client up (🔎 Клієнт). */
  lookupClient?: boolean;
  /** awaiting a new support phone to add to the contact list (📞 Контакти → ➕). */
  addingContact?: boolean;
  /** awaiting a chat id (+ optional label) to add a dispatcher (/dispatchers → ➕). */
  addingDispatcher?: boolean;
}

export type DispatcherContext = Context & SessionFlavor<DispatcherSession>;
export type DispatcherBot = Bot<DispatcherContext>;

/**
 * Provider of the shared bot instance. Depends ONLY on Config — this breaks the
 * cycle Orders → TelegramOrderDispatcher → bot → handlers → Orders: the sending
 * instance is decoupled from the handler wiring (DispatcherBotService). Both get
 * the same singleton (one token — one long-polling).
 * null if DISPATCHER_BOT_TOKEN is not set (the bot does not start).
 */
export const dispatcherBotProvider: Provider = {
  provide: DISPATCHER_BOT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DispatcherBot | null => {
    const token = config.get<string>('DISPATCHER_BOT_TOKEN');
    return token ? new Bot<DispatcherContext>(token) : null;
  },
};
