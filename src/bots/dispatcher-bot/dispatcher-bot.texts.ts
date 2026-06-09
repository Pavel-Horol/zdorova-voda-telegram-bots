import { InlineKeyboard } from 'grammy';
import { OrderStatus } from '../../../generated/prisma/enums';
import type {
  Order,
  Client,
  Address,
  PriceSettings,
} from '../../../generated/prisma/client';
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';

const STATUS_HEADER: Record<OrderStatus, string> = {
  [OrderStatus.CREATED]: '🔔 НОВЫЙ ЗАКАЗ',
  [OrderStatus.ACCEPTED]: '✅ ПРИНЯТ',
  [OrderStatus.DELIVERED]: '🚚 ДОСТАВЛЕН',
  [OrderStatus.CANCELLED]: '❌ ОТМЕНЁН',
};

const PRICE_FIELD_LABEL: Record<EditablePriceField, string> = {
  price1: 'Цена за 1 бутыль',
  price2: 'Цена за 2 бутыли',
  price3plus: 'Цена за 3+ бутыли',
  depositPerBottle: 'Залог за бутыль',
  pumpPrice: 'Помпа',
};

export function priceFieldLabel(field: EditablePriceField): string {
  return PRICE_FIELD_LABEL[field];
}

/** Приветствие диспетчера (/start) — над постоянным меню. */
export const dispatcherWelcome =
  'Диспетчерский бот 🚰\n' +
  'Новые заказы приходят сюда автоматически — обрабатывайте кнопками под ними.\n' +
  'Меню ниже: активные заказы, цены и статистика.';

/** Заголовок списка активных заказов (/orders). */
export function activeOrdersHeader(count: number): string {
  return `📋 Активные заказы: ${count}`;
}

/** Активных заказов нет (/orders). */
export const noActiveOrders = 'Активных заказов нет 👍';

/**
 * Строка заказа в привычном диспетчеру формате — её удобно переслать водителю
 * (SPEC §7). Повторный: «2по75 Адрес», первый: «2бут [ПЕРВЫЙ +помпа] Адрес».
 * Коммент — в скобках, как в примере спеки.
 */
function driverLine(order: Order, address: Address): string {
  const qty = order.isFirstOrder
    ? `${order.bottles}бут [ПЕРВЫЙ +помпа]`
    : `${order.bottles}по${order.totalPrice / order.bottles}`;
  const comment = address.comment ? ` (${address.comment})` : '';
  return `${qty} ${address.raw}${comment}`;
}

/** Полное сообщение о заказе для диспетчера (SPEC §7). Заголовок — по статусу. */
export function orderMessage(
  order: Order,
  client: Client,
  address: Address,
): string {
  const header = STATUS_HEADER[order.status];
  const firstMark = order.isFirstOrder ? '  [ПЕРВЫЙ ЗАКАЗ ⚠️]' : '';
  const name = client.name ?? 'без имени';
  return (
    `${header} #${order.id.slice(0, 8)}${firstMark}\n` +
    `${driverLine(order, address)}\n` +
    `Клиент: ${name} (${client.phone})\n` +
    `Сумма: ${order.totalPrice} грн`
  );
}

/**
 * Кнопки под заказом по текущему статусу (SPEC §7).
 * DELIVERED/CANCELLED — терминальные, кнопок нет (undefined снимает клавиатуру).
 */
export function orderKeyboard(
  orderId: string,
  status: OrderStatus,
): InlineKeyboard | undefined {
  switch (status) {
    case OrderStatus.CREATED:
      return new InlineKeyboard()
        .text('✅ Принят', `acc:${orderId}`)
        .text('❌ Отменить', `can:${orderId}`);
    case OrderStatus.ACCEPTED:
      return new InlineKeyboard()
        .text('🚚 Доставлен', `del:${orderId}`)
        .text('❌ Отменить', `can:${orderId}`);
    default:
      return undefined;
  }
}

/** Уведомление диспетчеру об отмене заказа клиентом из бота (SPEC §9). */
export function clientCancelledMessage(order: Order, client: Client): string {
  const name = client.name ?? 'без имени';
  return (
    `❌ Клиент отменил заказ #${order.id.slice(0, 8)}\n` +
    `Клиент: ${name} (${client.phone})`
  );
}

/** Текущие цены (SPEC §7, /prices). */
export function pricesMessage(prices: PriceSettings): string {
  return (
    'Текущие цены:\n' +
    `1 бутыль: ${prices.price1} грн\n` +
    `2 бутыли: ${prices.price2} грн\n` +
    `3+ бутылей: ${prices.price3plus} грн\n` +
    `Залог за бутыль: ${prices.depositPerBottle} грн\n` +
    `Помпа: ${prices.pumpPrice} грн`
  );
}

/** Кнопки выбора поля цены для редактирования (SPEC §7). */
export function pricesKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Цена 1', 'pe:price1')
    .text('Цена 2', 'pe:price2')
    .text('Цена 3+', 'pe:price3plus')
    .row()
    .text('Залог', 'pe:depositPerBottle')
    .text('Помпа', 'pe:pumpPrice');
}
