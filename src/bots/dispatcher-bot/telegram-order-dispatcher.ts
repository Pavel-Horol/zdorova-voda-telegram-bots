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
 * Telegram implementation of OrderDispatcher (SPEC §7): sends a new-order
 * notification to DISPATCHER_CHAT_ID with inline status buttons. Uses the shared
 * bot instance (DISPATCHER_BOT) only for sending; button handling — in DispatcherBotService.
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
        `DISPATCHER_BOT/CHAT_ID not configured — order ${order.id} not sent to the dispatcher`,
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
        `DISPATCHER_BOT/CHAT_ID not configured — cancellation of order ${order.id} not sent`,
      );
      return;
    }
    await this.bot.api.sendMessage(
      chatId,
      clientCancelledMessage(order, client),
    );
  }
}
