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

/** Prompt for delivery coordinates when geo-tagging an order's address (📍). */
export function geoTagPrompt(orderId: string): string {
  return (
    `📍 Замовлення #${orderId.slice(0, 8)}: надішліть локацію (📎 → Геопозиція) ` +
    'або вставте координати «49.42, 26.99» чи посилання на карту.'
  );
}

/** Prompt for the corrected declared bottle balance of an OWN_TARA order (step B). */
export function editClaimPrompt(orderId: string): string {
  return (
    `🔢 Замовлення #${orderId.slice(0, 8)}: введіть реальну кількість баків клієнта ` +
    'на руках (зарахується при прийнятті, на суму цього замовлення не впливає).'
  );
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
 * What to load and hand over — the composition the dispatcher relays to the driver
 * (SPEC §7). Uses the snapshot `order.newTara` (bottles under deposit at order time),
 * so the breakdown stays correct even after delivery changes the client's balance.
 * - STARTER_KIT: all bottles are new (deposit) + pump type.
 * - OWN_TARA: client's own bottles (exchange), optional pump add-on.
 * - REPEAT: exchange count + new-under-deposit count (when topping up tara).
 */
function composition(order: Order): string {
  const exchange = order.bottles - order.newTara;
  switch (order.kind) {
    case OrderKind.STARTER_KIT: {
      const pump = order.electro ? 'електрична' : 'звичайна';
      return (
        `📦 ${order.bottles} бут. — стартовий комплект (застава за ${order.newTara})\n` +
        `🔌 помпа: ${pump}`
      );
    }
    case OrderKind.OWN_TARA: {
      const pump = order.pumpAddon ? '\n🔌 + помпа (докупка)' : '';
      return `📦 ${order.bottles} бут. — своя тара, обмін${pump}`;
    }
    default: // REPEAT
      return order.newTara > 0
        ? `📦 ${order.bottles} бут.: ${exchange} обмін + ${order.newTara} нові (застава)`
        : `📦 ${order.bottles} бут. — обмін`;
  }
}

/** Full order message for the dispatcher (SPEC §7). Header — by status. */
export function orderMessage(
  order: Order,
  client: Client,
  address: Address,
): string {
  const header = STATUS_HEADER[order.status];
  // One mark per order kind. OWN_TARA = self-declared bottles to verify physically
  // (own or another brand's, re-labelled as ours) — show the declared count.
  const mark =
    order.kind === OrderKind.OWN_TARA
      ? `  [СВОЯ ТАРА ⚠️ звірити ${order.claimedOnHand ?? order.bottles} баків]`
      : order.kind === OrderKind.STARTER_KIT
        ? '  [ПЕРШЕ ЗАМОВЛЕННЯ ⚠️]'
        : '';
  const name = client.name ?? 'без імені';
  const comment = address.comment ? ` (${address.comment})` : '';
  // Tagged delivery point (dispatcher geo-tagging) — a tap-to-open map link.
  const geo =
    address.lat != null && address.lng != null
      ? `\n🗺 https://maps.google.com/?q=${address.lat},${address.lng}`
      : '';
  return (
    `${header} #${order.id.slice(0, 8)}${mark}\n` +
    `🕒 ${formatDateTime(order.createdAt)}\n` +
    `${composition(order)}\n` +
    `📍 ${address.raw}${comment}${geo}\n` +
    `👤 ${name} (${client.phone})\n` +
    `💰 ${order.totalPrice} грн готівкою водієві`
  );
}

/**
 * Buttons under an order by its current status (SPEC §7).
 * DELIVERED/CANCELLED — terminal, no buttons (undefined removes the keyboard).
 */
export function orderKeyboard(
  orderId: string,
  status: OrderStatus,
  kind?: OrderKind,
): InlineKeyboard | undefined {
  switch (status) {
    case OrderStatus.CREATED: {
      const kb = new InlineKeyboard()
        .text('✅ Прийнято', `acc:${orderId}`)
        .text('❌ Скасувати', `can:${orderId}`)
        .row()
        .text('✏️ Змінити', `edit:${orderId}`);
      // OWN_TARA before acceptance: let the dispatcher correct the self-declared
      // bottle balance (step B) — it is committed to the client on accept.
      if (kind === OrderKind.OWN_TARA) {
        kb.row().text('🔢 Звірити баки', `claim:${orderId}`);
      }
      kb.row().text('📍 Прив’язати точку', `geo:${orderId}`);
      return kb;
    }
    case OrderStatus.ACCEPTED:
      return new InlineKeyboard()
        .text('🚚 Доставлено', `del:${orderId}`)
        .text('❌ Скасувати', `can:${orderId}`)
        .row()
        .text('✏️ Змінити', `edit:${orderId}`)
        .row()
        .text('📍 Прив’язати точку', `geo:${orderId}`);
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

/** Notify the dispatcher about a callback request from the "Other" onboarding case. */
export function callbackRequestMessage(client: Client): string {
  const name = client.name ?? 'без імені';
  return (
    '📞 ЗАПИТ НА ДЗВІНОК (нестандартний випадок)\n' +
    `Клієнт: ${name} (${client.phone})\n` +
    'Клієнт обрав «Інше» в онбордингу — передзвоніть для оформлення.'
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
