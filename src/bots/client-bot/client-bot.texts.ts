import { OrderStatus } from '../../../generated/prisma/enums';
import type {
  Order,
  Address,
  PriceSettings,
} from '../../../generated/prisma/client';
import type { OrderQuote } from '../../modules/orders/orders.service';

/** Русское склонение слова «бутыль» по числу (1 бутыль / 2 бутыли / 5 бутылей). */
function bottlesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'бутыль';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'бутыли';
  return 'бутылей';
}

/** Дата заказа в коротком формате ДД.ММ для списка «Мои заказы». */
function shortDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

/** Статус заказа для клиента (короткая подпись, не путать с диспетчерской). */
const STATUS_LABEL: Record<OrderStatus, string> = {
  [OrderStatus.CREATED]: '🆕 принят',
  [OrderStatus.ACCEPTED]: '✅ подтверждён',
  [OrderStatus.DELIVERED]: '🚚 доставлен',
  [OrderStatus.CANCELLED]: '❌ отменён',
};

/**
 * Тексты экранов клиентского бота (SPEC §6). Чистые функции без побочных
 * эффектов — деньги и количества приходят готовыми из OrderQuote (CLAUDE.md §1).
 */
export const texts = {
  /** AWAIT_CONTACT (SPEC §6). */
  awaitContact:
    'Привет! 💧 Чтобы оформить заказ, поделитесь номером телефона — ' +
    'по нему мы определим ваш адрес доставки.',

  /** Главное меню для уже известного клиента (текст над reply-клавиатурой). */
  mainMenu(name: string | null): string {
    const hello = name ? `С возвращением, ${name}! 👋` : 'С возвращением! 👋';
    return `${hello}\nЧем поможем?`;
  },

  /** AWAIT_ADDRESS — первый заказ (SPEC §6). */
  awaitAddress:
    'Похоже, вы заказываете впервые 👋 Укажите адрес доставки: улица, дом, ' +
    'квартира. Если есть — добавьте этаж, код домофона, ориентир.',

  /** CHOOSE_QTY — приглашение выбрать количество. */
  chooseQty: 'Сколько бутылей 19 л привезти?',

  /**
   * CONFIRM (SPEC §6) — структурированный итог перед созданием заказа.
   * Ветка по quote.isFirstOrder: первый заказ показывает разбивку залог+помпа,
   * повторный — цену за бутыль. Адрес — raw + comment в скобках (если задан).
   */
  confirm(quote: OrderQuote, address: Address): string {
    const word = bottlesWord(quote.bottles);
    const breakdown = quote.isFirstOrder
      ? `залог ${quote.bottles}×${quote.depositPerBottle} + ` +
        `помпа ${quote.pumpPrice}, вода бесплатно`
      : `по ${quote.perBottle ?? 0} грн`;
    const comment = address.comment ? ` (${address.comment})` : '';
    return (
      'Хочу заказать:\n' +
      `📦 ${quote.bottles} ${word} (${breakdown})\n` +
      `📍 ${address.raw}${comment}\n` +
      `💰 К оплате: ${quote.totalPrice} грн (наличными водителю)`
    );
  },

  /** ORDER_DONE (SPEC §6). */
  orderDone: 'Заказ принят ✅ Скоро с вами свяжутся / привезут воду. Спасибо!',

  /** Отказ от подтверждения / отмена сценария — возврат в меню. */
  orderCancelled: 'Заказ отменён. Можно оформить заново в любой момент.',

  /** HISTORY — последние заказы клиента (SPEC §6, «Мои заказы»). */
  history(orders: Order[]): string {
    const lines = orders.map((o) => {
      const word = bottlesWord(o.bottles);
      return (
        `• ${shortDate(o.createdAt)} — ${o.bottles} ${word}, ` +
        `${o.totalPrice} грн — ${STATUS_LABEL[o.status]}`
      );
    });
    return `📋 Ваши последние заказы:\n${lines.join('\n')}`;
  },

  /** HISTORY — у клиента ещё нет заказов. */
  historyEmpty:
    'У вас пока нет заказов. Нажмите «🚰 Заказать воду», чтобы оформить первый.',

  /** PRICES — текущая сетка цен для клиента (SPEC §6, «Цены»). */
  prices(p: PriceSettings): string {
    return (
      '💰 Наши цены (бутыль 19 л):\n' +
      `• 1 бутыль — ${p.price1} грн\n` +
      `• 2 бутыли — ${p.price2} грн/шт\n` +
      `• 3+ бутылей — ${p.price3plus} грн/шт\n\n` +
      'Первый заказ (стартовый комплект):\n' +
      `• залог ${p.depositPerBottle} грн/бутыль + помпа ${p.pumpPrice} грн\n` +
      '• вода — бесплатно\n\n' +
      'Оплата наличными водителю.'
    );
  },

  /** CONTACTS — телефон поддержки (SPEC §6, «Связаться»; §11 — заглушка). */
  contacts(phone: string): string {
    return (
      '📞 Связаться с нами:\n' +
      `${phone}\n\n` +
      'Звоните, если нужна помощь с заказом или есть вопросы.'
    );
  },

  /** Клиент прислал не свой контакт (edge-кейс SPEC §9). */
  foreignContact:
    'Нужен именно ваш номер. Нажмите кнопку «Поделиться номером» ниже 🙏',
} as const;
