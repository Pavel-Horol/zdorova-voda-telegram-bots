import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context, type SessionFlavor } from 'grammy';
import type { DispatcherInputState } from './dispatcher-bot.fsm';

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
 * Dispatcher session: nothing but the mutually exclusive text-input modes. The field
 * list lives in ONE place ({@link DispatcherInputState}) so the text router and
 * `clearInputModes` always see exactly the modes the handlers can set.
 */
export type DispatcherSession = DispatcherInputState;

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
