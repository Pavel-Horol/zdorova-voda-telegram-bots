import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context, type SessionFlavor } from 'grammy';
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';
import type { OrderEditField } from './dispatcher-bot.fsm';

/** DI token for the shared dispatcher bot instance. */
export const DISPATCHER_BOT = Symbol('DISPATCHER_BOT');

/**
 * Configured dispatcher chat IDs (DISPATCHER_CHAT_ID + DISPATCHER2_CHAT_ID).
 * Order notifications are sent to all of them; the chat guard admits all of them.
 * Empty/missing values are dropped and duplicates removed. Add more numbered vars
 * here to support further dispatchers.
 */
export function dispatcherChatIds(config: ConfigService): string[] {
  const raw = [
    config.get<string>('DISPATCHER_CHAT_ID'),
    config.get<string>('DISPATCHER2_CHAT_ID'),
  ];
  const ids = raw.map((v) => v?.trim()).filter((v): v is string => !!v);
  return [...new Set(ids)];
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
