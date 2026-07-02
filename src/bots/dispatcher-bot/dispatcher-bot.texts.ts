import { InlineKeyboard } from 'grammy';
import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';
import type {
  Order,
  Client,
  Address,
  PriceSettings,
  ContactPhone,
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

/** Header of the edit sub-menu (✏️ Змінити): pick which field to change. */
export function editMenuPrompt(orderId: string): string {
  return `✏️ Замовлення #${orderId.slice(0, 8)}: що змінити?`;
}

/**
 * Sub-menu opened by "✏️ Змінити": pick the field to edit. Geo point and the
 * OWN_TARA claim keep their own buttons on the card — not repeated here.
 */
export function editMenuKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📦 Кількість', `ef:qty:${orderId}`)
    .row()
    .text('📍 Адресу', `ef:addr:${orderId}`)
    .text('📝 Коментар', `ef:comment:${orderId}`)
    .row()
    .text('❌ Скасувати', 'ef_cancel');
}

/** Prompt for the new bottle quantity when editing an order (✏️ Змінити). */
export function editQuantityPrompt(orderId: string): string {
  return `✏️ Замовлення #${orderId.slice(0, 8)}: введіть нову кількість бутлів.`;
}

/** Prompt for the new delivery address text when editing an order (✏️ → 📍 Адресу). */
export function editAddressPrompt(orderId: string): string {
  return `📍 Замовлення #${orderId.slice(0, 8)}: введіть нову адресу доставки.`;
}

/** Prompt for the new address comment when editing an order (✏️ → 📝 Коментар). */
export function editCommentPrompt(orderId: string): string {
  return `📝 Замовлення #${orderId.slice(0, 8)}: введіть новий коментар до адреси.`;
}

/** Prompt for delivery coordinates when geo-tagging an order's address (📍). */
export function geoTagPrompt(orderId: string): string {
  return (
    `📍 Замовлення #${orderId.slice(0, 8)}: надішліть локацію (📎 → Геопозиція) ` +
    'або вставте координати «49.42, 26.99» чи посилання на карту.'
  );
}

/**
 * Delivery-timing presets the dispatcher can send the client (🕒). Short keys keep
 * the callback data small (order ids are uuids). The phrase is what the client sees;
 * "✏️ Свій варіант" (custom text) is offered alongside these for anything else.
 */
const DELIVERY_ETA_PRESETS: Record<string, string> = {
  td: 'сьогодні',
  tm: 'завтра',
  h1: 'протягом години',
  h2: 'протягом 2 годин',
};

/** Maps a preset key to its phrase, or undefined for an unknown key (untrusted callback). */
export function deliveryEtaPreset(key: string): string | undefined {
  return DELIVERY_ETA_PRESETS[key];
}

/** Prompt shown when the dispatcher opens the delivery-timing picker (🕒). */
export function deliveryEtaPrompt(orderId: string): string {
  return `🕒 Замовлення #${orderId.slice(0, 8)}: що повідомити клієнту про час доставки?`;
}

/** Nudge to set the delivery time right after accepting an order. */
export function deliveryEtaAcceptNudge(orderId: string): string {
  return `✅ Прийнято #${orderId.slice(0, 8)}. Повідомити клієнту орієнтовний час?`;
}

/** Prompt for a custom delivery-timing message (✏️ Свій варіант). */
export function deliveryEtaCustomPrompt(orderId: string): string {
  return `🕒 Замовлення #${orderId.slice(0, 8)}: введіть текст про час доставки для клієнта.`;
}

/** Confirmation shown after a delivery-timing message was sent to the client. */
export function deliveryEtaSent(orderId: string, note: string): string {
  return `🕒 Клієнту надіслано (#${orderId.slice(0, 8)}): «${note}»`;
}

/** Buttons to pick / type the delivery-timing message for the client (🕒). */
export function deliveryEtaKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Сьогодні', `etap:td:${orderId}`)
    .text('Завтра', `etap:tm:${orderId}`)
    .row()
    .text('Протягом години', `etap:h1:${orderId}`)
    .text('Протягом 2 годин', `etap:h2:${orderId}`)
    .row()
    .text('✏️ Свій варіант', `etac:${orderId}`)
    .row()
    .text('❌ Скасувати', `etax:${orderId}`);
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
  '/client — знайти клієнта за номером телефону\n' +
  '/contacts — телефони підтримки, які бачить клієнт\n' +
  '/help — ця довідка';

/**
 * Support phone list for the dispatcher (📞 Контакти). Active numbers are shown to the
 * client on "Зв'язатися"; hidden ones are kept but not shown. Empty list → the client
 * sees the SUPPORT_PHONE env fallback, so there is never a dead end.
 */
export function contactsListMessage(contacts: ContactPhone[]): string {
  if (!contacts.length) {
    return (
      '📞 Телефони підтримки\n\n' +
      'Список порожній — клієнт бачить резервний номер з конфігурації.\n' +
      'Додайте номер кнопкою нижче 👇'
    );
  }
  const lines = contacts.map((c) => `${c.active ? '✅' : '🙈'} ${c.phone}`);
  return (
    '📞 Телефони підтримки:\n' +
    `${lines.join('\n')}\n\n` +
    '✅ — бачить клієнт, 🙈 — прихований.'
  );
}

/** Per-number management buttons (toggle show/hide, delete) + add. */
export function contactsKeyboard(contacts: ContactPhone[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of contacts) {
    const toggle = c.active ? `🙈 ${c.phone}` : `✅ ${c.phone}`;
    kb.text(toggle, `ct:tgl:${c.id}`).text('🗑', `ct:del:${c.id}`).row();
  }
  kb.text('➕ Додати номер', 'ct:add');
  return kb;
}

/** Prompt for a new support phone (📞 → ➕). */
export const addContactPrompt =
  'Введіть номер телефону, який бачитимуть клієнти ' +
  '(напр.: +380501234567 або 0501234567):';

/** New support phone was not recognised — ask again with an example. */
export const contactAddInvalid =
  'Не розпізнав номер. Введіть у форматі +380501234567 або 0501234567.';

/**
 * Commands for the Telegram menu ("/"). Registered via setMyCommands at startup —
 * the dispatcher sees hints without memorising the commands.
 */
export const dispatcherCommands = [
  { command: 'orders', description: '📋 Активні замовлення' },
  { command: 'prices', description: '💰 Ціни' },
  { command: 'stats', description: '📊 Статистика' },
  { command: 'client', description: '🔎 Знайти клієнта за телефоном' },
  { command: 'contacts', description: '📞 Телефони підтримки' },
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
      ? `\n🗺 ${mapsLink(address.lat, address.lng)}`
      : '';
  // Client note about THIS order (availability window etc.) — input for the driver.
  const note = order.note ? `\n📝 ${order.note}` : '';
  // Echo of the last delivery-timing message sent to the client (🗓, so it does not
  // clash with the created-at 🕒) — reminds the dispatcher what was promised.
  const delivery = order.deliveryNote
    ? `\n🗓 Клієнту: ${order.deliveryNote}`
    : '';
  return (
    `${header} #${order.id.slice(0, 8)}${mark}\n` +
    `🕒 ${formatDateTime(order.createdAt)}\n` +
    `${composition(order)}\n` +
    `📍 ${address.raw}${comment}${geo}${note}\n` +
    `👤 ${name} (${client.phone})\n` +
    `💰 ${order.totalPrice} грн готівкою водієві${delivery}`
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
      kb.row().text('🕒 Час доставки', `eta:${orderId}`);
      kb.row()
        .text('📍 Прив’язати точку', `geo:${orderId}`)
        .text('📋 Рядок водію', `drvline:${orderId}`);
      return kb;
    }
    case OrderStatus.ACCEPTED:
      return new InlineKeyboard()
        .text('🚚 Доставлено', `del:${orderId}`)
        .text('❌ Скасувати', `can:${orderId}`)
        .row()
        .text('✏️ Змінити', `edit:${orderId}`)
        .row()
        .text('🕒 Час доставки', `eta:${orderId}`)
        .row()
        .text('📍 Прив’язати точку', `geo:${orderId}`)
        .text('📋 Рядок водію', `drvline:${orderId}`);
    default:
      return undefined;
  }
}

/** Google Maps link for a tagged delivery point (shared by the card and driver line). */
function mapsLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/**
 * Compact "what + how much" head of the driver line. Water orders (REPEAT/OWN_TARA):
 * `Nпо{unit}` (+ `+{newTara} бак` when topping up tara under deposit, + `+помпа` for an
 * OWN_TARA add-on) and `= {total} грн`. Starter kit: a `[ПЕРШИЙ N +помпа|+електро]`
 * marker instead of a per-bottle price. `unit` is the live grid price per bottle; the
 * total is the frozen order total.
 */
function driverPriceSpec(order: Order, unit: number): string {
  if (order.kind === OrderKind.STARTER_KIT) {
    const pump = order.electro ? '+електро' : '+помпа';
    return `[ПЕРШИЙ ${order.bottles} ${pump}] = ${order.totalPrice} грн`;
  }
  let spec = `${order.bottles}по${unit}`;
  if (order.newTara > 0) spec += ` +${order.newTara} бак`;
  if (order.pumpAddon) spec += ' +помпа';
  return `${spec} = ${order.totalPrice} грн`;
}

/**
 * Forward-friendly hand-off block for the driver (PRODUCT.md "строка водію"). Sent as
 * a standalone message so the dispatcher can forward it. Format: price spec + address
 * + client name, and a maps link when the order's address is geo-tagged. `unit` is the
 * current per-bottle grid price (loaded by the handler).
 */
export function driverLine(
  order: Order,
  client: Client,
  address: Address,
  unit: number,
): string {
  const comment = address.comment ? ` (${address.comment})` : '';
  const name = client.name ?? 'без імені';
  const note = order.note ? `\n📝 ${order.note}` : '';
  let out =
    `${driverPriceSpec(order, unit)}\n` +
    `📍 ${address.raw}${comment}${note}\n` +
    `👤 ${name}`;
  if (address.lat != null && address.lng != null) {
    out += `\n🗺 ${mapsLink(address.lat, address.lng)}`;
  }
  return out;
}

/** Notify the dispatcher about an order cancelled by the client from the bot (SPEC §9). */
export function clientCancelledMessage(order: Order, client: Client): string {
  const name = client.name ?? 'без імені';
  return (
    `❌ Клієнт скасував замовлення #${order.id.slice(0, 8)}\n` +
    `Клієнт: ${name} (${client.phone})`
  );
}

/** Prompt for the phone number when looking a client up (🔎 Клієнт). */
export const clientLookupPrompt =
  'Введіть номер телефону клієнта (можна частину, напр. останні цифри):';

/** No client matched the looked-up phone. */
export const noClientFound = 'Клієнтів за цим номером не знайдено.';

/**
 * Client card for the dispatcher lookup (🔎 Клієнт): identity, tara/pump state, the
 * default address (with a map link if tagged) and the last order. Read-only summary
 * to help the dispatcher when a client calls.
 */
export function clientCardMessage(
  client: Client,
  address: Address | null,
  lastOrder: Order | null,
): string {
  const name = client.name ?? 'без імені';
  const review = client.pendingReview ? ' ⚠️ на звірці' : '';
  const pump = client.hasPump ? 'є помпа' : 'без помпи';
  const lines = [
    `👤 ${name} (${client.phone})${review}`,
    `🪣 баків на руках: ${client.bottlesOnHand}, ${pump}`,
  ];
  if (address) {
    const comment = address.comment ? ` (${address.comment})` : '';
    let line = `📍 ${address.raw}${comment}`;
    if (address.lat != null && address.lng != null) {
      line += `\n🗺 ${mapsLink(address.lat, address.lng)}`;
    }
    lines.push(line);
  } else {
    lines.push('📍 адреси ще немає');
  }
  if (lastOrder) {
    lines.push(
      `🕒 останнє: ${formatDateTime(lastOrder.createdAt)} — ` +
        `${lastOrder.bottles} бут., ${lastOrder.totalPrice} грн`,
    );
  }
  return lines.join('\n');
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
