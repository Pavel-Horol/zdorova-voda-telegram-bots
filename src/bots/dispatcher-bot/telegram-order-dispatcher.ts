import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InlineKeyboard } from 'grammy';
import type { Order, Client, Address } from '../../../generated/prisma/client';
import type { OrderDispatcher } from '../shared/order-dispatcher';
import {
  DISPATCHER_BOT,
  dispatcherChatIds,
  type DispatcherBot,
} from './dispatcher-bot.bot';
import {
  orderMessage,
  orderKeyboard,
  clientCancelledMessage,
  callbackRequestMessage,
} from './dispatcher-bot.texts';

/**
 * Telegram implementation of OrderDispatcher (SPEC §7): sends a new-order
 * notification to every configured dispatcher chat (DISPATCHER_CHAT_ID +
 * DISPATCHER2_CHAT_ID) with inline status buttons. Uses the shared bot instance
 * (DISPATCHER_BOT) only for sending; button handling — in DispatcherBotService.
 *
 * Each dispatcher gets its own copy of the message: when one acts on an order, only
 * their copy is redrawn; a stale tap in the other chat is rejected gracefully by the
 * status guard ("already handled"). All sends are best-effort — a failure to reach
 * one dispatcher is logged and does not block the others or the order itself.
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
    await this.broadcast(
      orderMessage(order, client, address),
      `order ${order.id}`,
      orderKeyboard(order.id, order.status),
    );
  }

  async notifyClientCancelled(order: Order, client: Client): Promise<void> {
    await this.broadcast(
      clientCancelledMessage(order, client),
      `cancellation of order ${order.id}`,
    );
  }

  async notifyCallbackRequest(client: Client): Promise<void> {
    await this.broadcast(
      callbackRequestMessage(client),
      `callback request from ${client.phone}`,
    );
  }

  /**
   * Sends a message to all configured dispatcher chats. Best-effort: per-chat
   * failures are logged, never thrown (must not break order creation, CLAUDE.md §8).
   */
  private async broadcast(
    text: string,
    context: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const chatIds = dispatcherChatIds(this.config);
    if (!this.bot || !chatIds.length) {
      this.logger.warn(
        `DISPATCHER_BOT/CHAT_ID not configured — ${context} not sent`,
      );
      return;
    }
    const bot = this.bot;
    const results = await Promise.allSettled(
      chatIds.map((chatId) =>
        bot.api.sendMessage(
          chatId,
          text,
          keyboard ? { reply_markup: keyboard } : undefined,
        ),
      ),
    );
    results.forEach((res, i) => {
      if (res.status === 'rejected') {
        const reason =
          res.reason instanceof Error ? res.reason.message : String(res.reason);
        this.logger.warn(
          `failed to send ${context} to dispatcher ${chatIds[i]}: ${reason}`,
        );
      }
    });
  }
}
