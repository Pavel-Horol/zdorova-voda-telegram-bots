import { InlineKeyboard } from 'grammy';
import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';
import type {
  Order,
  Client,
  Address,
  PriceSettings,
} from '../../../generated/prisma/client';
import type { EditablePriceField } from '../../modules/pricing-settings/pricing-settings.service';

const STATUS_HEADER: Record<OrderStatus, string> = {
  [OrderStatus.CREATED]: '🔔 НОВЕ ЗАМОВЛЕННЯ',
  [OrderStatus.ACCEPTED]: '✅ ПРИЙНЯТО',
  [OrderStatus.DELIVERED]: '🚚 ДОСТАВЛЕНО',
  [OrderStatus.CANCELLED]: '❌ СКАСОВАНО',
};

const PRICE_FIELD_LABEL: Record<EditablePriceField, string> = {
  price1: 'Вода: 1 бутель',
  priceFrom2: 'Вода: від 2',
  priceFrom6: 'Вода: від 6',
  depositPerBottle: 'Застава за бак',
  pumpPrice: 'Помпа',
  electroPumpPrice: 'Помпа електро',
  waterStartPrice: 'Старт-вода',
};

export function priceFieldLabel(field: EditablePriceField): string {
  return PRICE_FIELD_LABEL[field];
}

/** Dispatcher greeting (/start) — above the persistent menu. */
export const dispatcherWelcome =
  'Диспетчерський бот 🚰\n' +
  'Нові замовлення надходять сюди автоматично — обробляйте кнопками під ними.\n' +
  'Меню нижче: активні замовлення, ціни та статистика.';

/** Header of the active orders list (/orders). */
export function activeOrdersHeader(count: number): string {
  return `📋 Активні замовлення: ${count}`;
}

/** Order date-time in the card: Kyiv time, format "DD.MM, HH:MM". */
function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** /stats summary (SPEC §7): today + this week, without cancelled. */
export function statsMessage(stats: {
  today: { count: number; sum: number };
  week: { count: number; sum: number };
}): string {
  return (
    '📊 Статистика (без скасованих):\n' +
    `Сьогодні: ${stats.today.count} замовлень, сума ${stats.today.sum} грн\n` +
    `За тиждень: ${stats.week.count} замовлень, сума ${stats.week.sum} грн`
  );
}

/** No active orders (/orders). */
export const noActiveOrders = 'Активних замовлень немає 👍';

/** Prompt for the new bottle quantity when editing an order (✏️ Змінити). */
export function editQuantityPrompt(orderId: string): string {
  return `✏️ Замовлення #${orderId.slice(0, 8)}: введіть нову кількість бутлів.`;
}

/** Command reference (/help). */
export const dispatcherHelp =
  'Що вміє бот:\n' +
  '• Нові замовлення надходять автоматично — кнопки прямо під повідомленням.\n' +
  '/orders — активні замовлення (created/accepted) списком\n' +
  '/prices — переглянути та змінити ціни\n' +
  '/stats — статистика за замовленнями\n' +
  '/help — ця довідка';

/**
 * Commands for the Telegram menu ("/"). Registered via setMyCommands at startup —
 * the dispatcher sees hints without memorising the commands.
 */
export const dispatcherCommands = [
  { command: 'orders', description: '📋 Активні замовлення' },
  { command: 'prices', description: '💰 Ціни' },
  { command: 'stats', description: '📊 Статистика' },
  { command: 'help', description: '❓ Довідка' },
];

/**
 * Order line in the dispatcher's usual format — convenient to forward to the
 * driver (SPEC §7). Repeat: "2по75 Address", first: "2бут [ПЕРШИЙ +помпа] Address".
 * Comment — in parentheses, as in the spec example.
 */
function driverLine(order: Order, address: Address): string {
  const pumpMark = order.electro ? '+електро' : '+помпа';
  const ownPump = order.pumpAddon ? ' +помпа' : '';
  const qty =
    order.kind === OrderKind.STARTER_KIT
      ? `${order.bottles}бут [ПЕРШИЙ ${pumpMark}]`
      : order.kind === OrderKind.OWN_TARA
        ? `${order.bottles}по${order.totalPrice / order.bottles} [СВОЯ ТАРА${ownPump}]`
        : `${order.bottles}по${order.totalPrice / order.bottles}`;
  const comment = address.comment ? ` (${address.comment})` : '';
  return `${qty} ${address.raw}${comment}`;
}

/** Full order message for the dispatcher (SPEC §7). Header — by status. */
export function orderMessage(
  order: Order,
  client: Client,
  address: Address,
): string {
  const header = STATUS_HEADER[order.status];
  const firstMark = client.pendingReview
    ? '  [ЗВІРИТИ ⚠️ заявлений діючим]'
    : order.kind === OrderKind.STARTER_KIT
      ? '  [ПЕРШЕ ЗАМОВЛЕННЯ ⚠️]'
      : order.kind === OrderKind.OWN_TARA
        ? '  [СВОЯ ТАРА ⚠️ перевірити бак]'
        : '';
  const name = client.name ?? 'без імені';
  return (
    `${header} #${order.id.slice(0, 8)}${firstMark}\n` +
    `🕒 ${formatDateTime(order.createdAt)}\n` +
    `${driverLine(order, address)}\n` +
    `Клієнт: ${name} (${client.phone})\n` +
    `Сума: ${order.totalPrice} грн`
  );
}

/**
 * Buttons under an order by its current status (SPEC §7).
 * DELIVERED/CANCELLED — terminal, no buttons (undefined removes the keyboard).
 */
export function orderKeyboard(
  orderId: string,
  status: OrderStatus,
): InlineKeyboard | undefined {
  switch (status) {
    case OrderStatus.CREATED:
      return new InlineKeyboard()
        .text('✅ Прийнято', `acc:${orderId}`)
        .text('❌ Скасувати', `can:${orderId}`)
        .row()
        .text('✏️ Змінити', `edit:${orderId}`);
    case OrderStatus.ACCEPTED:
      return new InlineKeyboard()
        .text('🚚 Доставлено', `del:${orderId}`)
        .text('❌ Скасувати', `can:${orderId}`)
        .row()
        .text('✏️ Змінити', `edit:${orderId}`);
    default:
      return undefined;
  }
}

/** Notify the dispatcher about an order cancelled by the client from the bot (SPEC §9). */
export function clientCancelledMessage(order: Order, client: Client): string {
  const name = client.name ?? 'без імені';
  return (
    `❌ Клієнт скасував замовлення #${order.id.slice(0, 8)}\n` +
    `Клієнт: ${name} (${client.phone})`
  );
}

/** Current prices (SPEC §7, /prices). */
export function pricesMessage(prices: PriceSettings): string {
  return (
    'Поточні ціни:\n' +
    `Вода: 1 — ${prices.price1}, від 2 — ${prices.priceFrom2}, від 6 — ${prices.priceFrom6} грн\n` +
    `Застава за бак: ${prices.depositPerBottle} грн\n` +
    `Помпа: ${prices.pumpPrice} грн (електро ${prices.electroPumpPrice})\n` +
    `Старт-вода: ${prices.waterStartPrice} грн/бак`
  );
}

/** Cancel button under the new price value prompt. */
export function priceEditCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Скасувати', 'pe_cancel');
}

/** Buttons to pick a price field for editing (SPEC §7). */
export function pricesKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Вода 1', 'pe:price1')
    .text('Вода від2', 'pe:priceFrom2')
    .text('Вода від6', 'pe:priceFrom6')
    .row()
    .text('Застава', 'pe:depositPerBottle')
    .text('Помпа', 'pe:pumpPrice')
    .text('Помпа ел', 'pe:electroPumpPrice')
    .row()
    .text('Старт-вода', 'pe:waterStartPrice');
}
