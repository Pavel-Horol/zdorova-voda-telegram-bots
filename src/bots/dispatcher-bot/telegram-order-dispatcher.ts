import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Order, Client, Address } from '../../../generated/prisma/client';
import type { OrderDispatcher } from '../shared/order-dispatcher';
import { DISPATCHER_BOT, type DispatcherBot } from './dispatcher-bot.bot';
import {
  orderMessage,
  orderKeyboard,
  clientCancelledMessage,
} from './dispatcher-bot.texts';

/**
 * Telegram-реализация OrderDispatcher (SPEC §7): шлёт уведомление о новом заказе
 * в DISPATCHER_CHAT_ID с inline-кнопками статусов. Использует общий инстанс бота
 * (DISPATCHER_BOT) только на отправку; приём кнопок — в DispatcherBotService.
 */
@Injectable()
export class TelegramOrderDispatcher implements OrderDispatcher {
  private readonly logger = new Logger(TelegramOrderDispatcher.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(DISPATCHER_BOT) private readonly bot: DispatcherBot | null,
  ) {}

  async notifyNewOrder(
    order: Order,
    client: Client,
    address: Address,
  ): Promise<void> {
    const chatId = this.config.get<string>('DISPATCHER_CHAT_ID');
    if (!this.bot || !chatId) {
      this.logger.warn(
        `DISPATCHER_BOT/CHAT_ID не настроены — заказ ${order.id} не отправлен диспетчеру`,
      );
      return;
    }

    await this.bot.api.sendMessage(
      chatId,
      orderMessage(order, client, address),
      {
        reply_markup: orderKeyboard(order.id, order.status),
      },
    );
  }

  async notifyClientCancelled(order: Order, client: Client): Promise<void> {
    const chatId = this.config.get<string>('DISPATCHER_CHAT_ID');
    if (!this.bot || !chatId) {
      this.logger.warn(
        `DISPATCHER_BOT/CHAT_ID не настроены — отмена заказа ${order.id} не отправлена`,
      );
      return;
    }
    await this.bot.api.sendMessage(
      chatId,
      clientCancelledMessage(order, client),
    );
  }
}
