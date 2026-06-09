import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, type Context, type SessionFlavor } from 'grammy';
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';

/** DI-токен общего инстанса диспетчерского бота. */
export const DISPATCHER_BOT = Symbol('DISPATCHER_BOT');

/**
 * Сессия диспетчера. Два режима текстового ввода, взаимоисключающие:
 * редактирование цены (/prices) и редактирование количества в заказе (✏️).
 */
export interface DispatcherSession {
  editingPriceField?: EditablePriceField;
  /** id заказа, для которого ждём новое количество бутылей (flow ✏️ Изменить). */
  editingOrderId?: string;
}

export type DispatcherContext = Context & SessionFlavor<DispatcherSession>;
export type DispatcherBot = Bot<DispatcherContext>;

/**
 * Провайдер общего инстанса бота. Зависит ТОЛЬКО от Config — это разрывает цикл
 * Orders → TelegramOrderDispatcher → бот → handlers → Orders: инстанс для
 * отправки отделён от обвязки обработчиков (DispatcherBotService). Оба получают
 * один и тот же синглтон (на один токен — один long-polling).
 * null, если DISPATCHER_BOT_TOKEN не задан (бот не поднимается).
 */
export const dispatcherBotProvider: Provider = {
  provide: DISPATCHER_BOT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DispatcherBot | null => {
    const token = config.get<string>('DISPATCHER_BOT_TOKEN');
    return token ? new Bot<DispatcherContext>(token) : null;
  },
};
