import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';
import type {
  Order,
  Address,
  PriceSettings,
} from '../../../generated/prisma/client';
import type { OrderQuote } from '../../modules/orders/orders.service';

/** Ukrainian plural form of "бутель" by count (1 бутель / 2 бутлі / 5 бутлів). */
function bottlesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'бутель';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'бутлі';
  return 'бутлів';
}

/** Order date in short DD.MM format for the "My orders" list. */
function shortDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

/** Order status for the client (short label, not the dispatcher one). */
const STATUS_LABEL: Record<OrderStatus, string> = {
  [OrderStatus.CREATED]: '🆕 прийнято',
  [OrderStatus.ACCEPTED]: '✅ підтверджено',
  [OrderStatus.DELIVERED]: '🚚 доставлено',
  [OrderStatus.CANCELLED]: '❌ скасовано',
};

/**
 * Client bot screen texts (SPEC §6). Pure functions without side effects —
 * money and quantities arrive ready from OrderQuote (CLAUDE.md §1).
 */
export const texts = {
  /**
   * Bot profile: the "about" line in the profile card (Telegram limit — 120 chars).
   * Synced at startup by ClientBotService, not edited by hand in BotFather.
   */
  botShortDescription:
    '💧 «Здорова Вода» — доставка питної води 19 л додому та в офіс. ' +
    'Замовлення за хвилину.',

  /**
   * Bot profile: the description shown in the empty chat before /start
   * (Telegram limit — 512 chars). Synced at startup by ClientBotService.
   */
  botDescription:
    'Вітаємо у «Здорова Вода»! 💧\n\n' +
    'Доставляємо питну воду в бутлях 19 л додому та в офіс.\n\n' +
    '🚰 Замовлення за кілька натискань\n' +
    '🔄 Повтор минулого замовлення одним дотиком\n' +
    '💰 Актуальні ціни завжди під рукою\n' +
    '💵 Оплата готівкою водієві\n\n' +
    'Натисніть «Розпочати», щоб оформити перше замовлення.',

  /** AWAIT_CONTACT (SPEC §6) — greeting for a brand-new user after /start. */
  awaitContact:
    'Вітаємо у «Здорова Вода»! 💧 Доставляємо питну воду (бутлі 19 л) ' +
    'додому та в офіс.\n\n' +
    'Щоб оформити замовлення, поділіться номером телефону — ' +
    'за ним ми визначимо вашу адресу доставки.',

  /** Main menu for an already known client (text above the reply keyboard). */
  mainMenu(name: string | null): string {
    const hello = name ? `З поверненням, ${name}! 👋` : 'З поверненням! 👋';
    return `${hello}\nЧим допоможемо?`;
  },

  /** AWAIT_ADDRESS — first order (SPEC §6). Details (floor/intercom) are asked next. */
  awaitAddress:
    'Схоже, ви замовляєте вперше 👋 Напишіть адресу доставки: вулиця, ' +
    'будинок, квартира — напр.: Гагаріна, 12, кв. 5.',

  /** Changing an EXISTING address (standalone management or editing on Confirm). */
  changeAddress:
    'Введіть нову адресу доставки: вулиця, будинок, квартира — ' +
    'напр.: Гагаріна, 12, кв. 5.',

  /** AWAIT_COMMENT — address details (floor/intercom/landmark), optional. */
  awaitComment:
    'Додайте деталі до адреси: поверх, код домофона, орієнтир — або натисніть ' +
    '«Пропустити».',

  /** CHOOSE_QTY — prompt to choose the quantity. */
  chooseQty: 'Скільки бутлів 19 л привезти?',

  /** EDIT_MENU — "what to change" before going back to the confirmation (✏️ Змінити). */
  editMenu: 'Що змінити в замовленні?',

  /** ONBOARDING — choice screen for a new client (PRODUCT.md). */
  onboarding:
    'Щоб порахувати правильно — що у вас уже є?\n\n' +
    '🆕 Стартовий комплект — потрібні бак, помпа та вода\n' +
    '💧 У мене вже є баки (19 л) — і свої, і ваші; заставу не платите\n' +
    '⚙️ Інше — попросити диспетчера передзвонити',

  /** Number of bottles on hand — button screen (the "I already have bottles" branch → OWN_TARA). */
  ownTaraChoose:
    'Скільки у вас баків (19 л) на руках? На стільки порахуємо обмін.',

  /** Number of bottles on hand — manual entry ("Інша кількість"). */
  ownTaraCount:
    'Скільки у вас баків (19 л) на руках? Надішліть числом — напр.: 8.',

  /** Invalid number of bottles. */
  ownTaraInvalid: 'Потрібне число від 1 — напр.: 8. Скільки у вас баків?',

  /** Starter kit composition + pump type choice (T5). */
  pumpChoice(prices: PriceSettings): string {
    return (
      '🆕 Стартовий комплект — усе для старту:\n' +
      `• бак 19 л — застава ${prices.depositPerBottle} грн \n` +
      `• перша вода — ${prices.waterStartPrice} грн/бак\n` +
      '• помпа — оберіть тип нижче 👇\n\n' +
      'Яка помпа в комплекті?\n' +
      `• Звичайна — ${prices.pumpPrice} грн\n` +
      `• Електрична — ${prices.electroPumpPrice} грн`
    );
  },

  /** Own bottles: do you have a pump, otherwise add-on purchase (T5). */
  ownPumpAsk(pumpPrice: number): string {
    return `Помпа у вас є? Якщо ні — додамо до замовлення (${pumpPrice} грн).`;
  },

  /** "Other" — non-standard, handled by the dispatcher via a call. */
  onboardingToDispatcher(phone: string): string {
    return (
      'Передали запит диспетчеру — він передзвонить вам найближчим часом 📞\n' +
      `Якщо зручніше — зателефонуйте самі: ${phone}`
    );
  },

  /** First order with own bottles is still awaiting the dispatcher's confirmation. */
  awaitingFirstOrderReview:
    'Ваше перше замовлення ще на підтвердженні в диспетчера ⏳\n' +
    'Щойно його підтвердять — ви зможете оформити наступне.',

  /** Label of the "Repeat last order" button (SPEC §6) with plural form. */
  repeatButton(n: number): string {
    return `🔄 Повторити: ${n} ${bottlesWord(n)}`;
  },

  /**
   * CONFIRM (SPEC §6) — structured summary before creating the order.
   * Branches on quote.kind: STARTER_KIT shows the starter-kit breakdown, the
   * rest — price per bottle. Address — raw + comment in parentheses.
   */
  confirm(quote: OrderQuote, address: Address, note?: string | null): string {
    const word = bottlesWord(quote.bottles);
    let breakdown: string;
    if (quote.kind === OrderKind.STARTER_KIT) {
      const pump = quote.electro
        ? `електро-помпа ${quote.electroPumpPrice}`
        : `помпа ${quote.pumpPrice}`;
      breakdown =
        `стартовий комплект: застава ${quote.bottles}×${quote.depositPerBottle} + ` +
        `${pump} + вода ${quote.bottles}×${quote.waterStartPrice}`;
    } else if (quote.newTara > 0) {
      // Tara top-up: water by grid for the whole quantity + deposit per new bottle.
      breakdown =
        `вода ${quote.bottles}×${quote.perBottle ?? 0} + ` +
        `${quote.newTara} нов. бак ×${quote.depositPerBottle} застава`;
    } else {
      breakdown = `по ${quote.perBottle ?? 0} грн`;
    }
    // Pump add-on for own bottles (OWN_TARA without a pump).
    if (quote.pumpAddon) breakdown += ` + помпа ${quote.pumpPrice}`;
    const comment = address.comment ? ` (${address.comment})` : '';
    const noteLine = note ? `\n📝 ${note}` : '';
    return (
      'Хочу замовити:\n' +
      `📦 ${quote.bottles} ${word} (${breakdown})\n` +
      `📍 ${address.raw}${comment}${noteLine}\n` +
      `💰 До сплати: ${quote.totalPrice} грн (готівкою водієві)`
    );
  },

  /** Prompt for the optional client note about this order (from Confirm). */
  orderNotePrompt:
    'Напишіть коментар до замовлення (напр. «мене не буде з 14 до 16», ' +
    '«дзвоніть за годину»):',

  /** ORDER_DONE (SPEC §6). */
  orderDone:
    'Замовлення прийнято ✅ Незабаром з вами зв’яжуться / привезуть воду. Дякуємо!',

  /**
   * Notify the client about an order status change by the dispatcher (SPEC §8).
   * For CREATED returns null — it is the initial status, we do not notify about it.
   */
  orderStatusUpdate(order: Order): string | null {
    switch (order.status) {
      case OrderStatus.ACCEPTED:
        return 'Ваше замовлення прийнято ✅ Готуємо до доставки.';
      case OrderStatus.DELIVERED:
        return 'Замовлення доставлено 🚚 Дякуємо, що обрали нас!';
      case OrderStatus.CANCELLED:
        return 'Ваше замовлення скасовано. Якщо це помилка — зв’яжіться з нами.';
      default:
        return null;
    }
  },

  /**
   * Notify the client that the dispatcher edited their order (SPEC §7): shows the
   * current quantity and total so a quantity/price change is visible, and works for
   * an address/comment edit too (numbers stay the same, the message just confirms it).
   */
  orderEdited(order: Order): string {
    const word = bottlesWord(order.bottles);
    return (
      'Ваше замовлення оновлено диспетчером 📝\n' +
      `Зараз: ${order.bottles} ${word}, сума ${order.totalPrice} грн.`
    );
  },

  /**
   * Notify the client about the delivery-timing message the dispatcher set for their
   * order (🕒): "сьогодні", "перенесено на завтра", "протягом години", … The dispatcher
   * writes the phrase; we just wrap it. Empty/blank note → null (nothing to send).
   */
  deliveryNoteUpdate(order: Order): string | null {
    const note = order.deliveryNote?.trim();
    if (!note) return null;
    return `🕒 Час доставки вашого замовлення: ${note}`;
  },

  /** Order creation failed — ask to retry (edge §9). */
  orderError:
    'Не вдалося оформити замовлення 😔 Спробуйте ще раз або зателефонуйте нам.',

  /** A non-text was sent on input steps (photo/geo/voice) — ask for text. */
  sendAsText: 'Надішліть, будь ласка, текстом 🙏',

  /** Declining confirmation / cancelling the scenario — return to the menu. */
  orderCancelled: 'Замовлення скасовано. Можна оформити заново будь-коли.',

  /** HISTORY — the client's latest orders (SPEC §6, "My orders"). */
  history(orders: Order[]): string {
    const lines = orders.map((o) => {
      const word = bottlesWord(o.bottles);
      return (
        `• ${shortDate(o.createdAt)} — ${o.bottles} ${word}, ` +
        `${o.totalPrice} грн — ${STATUS_LABEL[o.status]}`
      );
    });
    return `📋 Ваші останні замовлення:\n${lines.join('\n')}`;
  },

  /**
   * Label of the cancel button under an order in "My orders". Shows date + quantity
   * (not a raw id fragment) so the client can tell which order they are cancelling.
   */
  cancelOrderButton(order: Order): string {
    const word = bottlesWord(order.bottles);
    return `❌ Скасувати: ${order.bottles} ${word} (${shortDate(order.createdAt)})`;
  },

  /** HISTORY — the client has no orders yet. */
  historyEmpty:
    'У вас поки немає замовлень. Натисніть «🚰 Замовити воду», щоб оформити перше.',

  /** PRICES — the current price grid for the client (SPEC §6, "Prices"). */
  prices(p: PriceSettings): string {
    return (
      '💰 Наші ціни (бутель 19 л):\n' +
      `• 1 бутель — ${p.price1} грн\n` +
      `• від 2 — ${p.priceFrom2} грн/шт\n` +
      `• від 6 — ${p.priceFrom6} грн/шт\n\n` +
      'Перше замовлення (стартовий комплект):\n' +
      `• застава ${p.depositPerBottle} грн/бак + помпа ${p.pumpPrice} грн ` +
      `+ старт-вода ${p.waterStartPrice} грн/бак\n\n` +
      'Оплата готівкою водієві.'
    );
  },

  /** "📍 Моя адреса" — the saved default address (with a change button). */
  addressView(address: Address): string {
    const comment = address.comment ? `\n📝 ${address.comment}` : '';
    return `📍 Ваша адреса доставки:\n${address.raw}${comment}`;
  },

  /** Confirmation after the client saved/changed the address standalone. */
  addressSaved: 'Адресу збережено ✅',

  /**
   * CONTACTS — support phones (SPEC §6, "Contact us"). Dispatcher-managed; one per line
   * with a 📱 marker (Telegram keeps the numbers tap-to-call). Blank line after the
   * header for scannability (UX P6).
   */
  contacts(phones: string[]): string {
    const list = phones.map((p) => `📱 ${p}`).join('\n');
    return (
      '📞 Зв’язатися з нами\n\n' +
      `${list}\n\n` +
      'Телефонуйте, якщо потрібна допомога із замовленням або є запитання.'
    );
  },

  /** The client shared someone else's contact (edge case SPEC §9). */
  foreignContact:
    'Потрібен саме ваш номер. Натисніть кнопку «Поділитися номером» нижче 🙏',
} as const;
