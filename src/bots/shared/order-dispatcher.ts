import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Order, Client, Address } from '../../../generated/prisma/client';

/**
 * DI-токен для OrderDispatcher. Интерфейсы в рантайме не существуют, поэтому
 * провайдер регистрируется и инжектится по этому токену (см. OrdersModule).
 */
export const ORDER_DISPATCHER = Symbol('ORDER_DISPATCHER');

/**
 * Абстракция «куда уходит готовый заказ» (CLAUDE.md §2, SPEC §10).
 * Бизнес-логика заказа НЕ знает, кто получает уведомление: сейчас это
 * диспетчерский бот, в v2 — ViberDispatcher, без правок в orders.
 *
 * order/client/address передаются готовыми: OrdersService уже загрузил их при
 * оформлении, поэтому dispatcher НЕ ходит в БД сам (CLAUDE.md §6).
 */
export interface OrderDispatcher {
  notifyNewOrder(order: Order, client: Client, address: Address): Promise<void>;
}

/**
 * Логирующая реализация для разработки и тестов: пишет заказ в лог и ничего
 * не отправляет. Позволяет создать заказ и увидеть, что уведомление «вызвалось»,
 * без живых ботов и токенов.
 */
@Injectable()
export class LogOrderDispatcher implements OrderDispatcher {
  private readonly logger = new Logger(LogOrderDispatcher.name);

  notifyNewOrder(
    order: Order,
    client: Client,
    address: Address,
  ): Promise<void> {
    this.logger.log(
      `New order ${order.id}: ${order.bottles} бут., ${order.totalPrice} грн — ` +
        `${client.name ?? 'без имени'} ${client.phone}, ${address.raw}`,
    );
    return Promise.resolve();
  }
}

/**
 * Отправка уведомления о заказе в диспетчерский бот по DISPATCHER_CHAT_ID
 * (SPEC §7, §11). Пока заглушка: текст уже собирается, но реальная отправка
 * через grammY-инстанс появится в задаче про ботов (TODO ниже).
 */
@Injectable()
export class TelegramOrderDispatcher implements OrderDispatcher {
  private readonly logger = new Logger(TelegramOrderDispatcher.name);

  constructor(private readonly config: ConfigService) {}

  notifyNewOrder(
    order: Order,
    client: Client,
    address: Address,
  ): Promise<void> {
    const chatId = this.config.get<string>('DISPATCHER_CHAT_ID');
    if (!chatId) {
      this.logger.warn(
        `DISPATCHER_CHAT_ID не задан — уведомление о заказе ${order.id} не отправлено`,
      );
      return Promise.resolve();
    }

    const text = this.buildMessage(order, client, address);
    // TODO(bots): отправить text в диспетчерский бот через grammY:
    //   await this.dispatcherBot.api.sendMessage(chatId, text)
    this.logger.debug(`Would send to ${chatId}:\n${text}`);
    return Promise.resolve();
  }

  private buildMessage(order: Order, client: Client, address: Address): string {
    const name = client.name ?? 'без имени';
    const firstOrderMark = order.isFirstOrder ? ' (первый заказ)' : '';
    const comment = address.comment ? `\nКомментарий: ${address.comment}` : '';
    return (
      `🆕 Новый заказ${firstOrderMark}\n` +
      `Клиент: ${name}, ${client.phone}\n` +
      `Адрес: ${address.raw}${comment}\n` +
      `Бутылей: ${order.bottles}\n` +
      `Сумма: ${order.totalPrice} грн`
    );
  }
}
