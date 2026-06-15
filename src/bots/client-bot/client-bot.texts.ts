import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';
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

  /** AWAIT_COMMENT — комментарий к адресу (этаж/домофон/ориентир), необязателен. */
  awaitComment:
    'Добавьте детали к адресу: этаж, код домофона, ориентир — или нажмите ' +
    '«Пропустить».',

  /** CHOOSE_QTY — приглашение выбрать количество. */
  chooseQty: 'Сколько бутылей 19 л привезти?',

  /** ONBOARDING — экран выбора для нового клиента (STEP3 T3). */
  onboarding:
    'Чтобы посчитать правильно — что у вас уже есть?\n\n' +
    '🆕 Стартовый комплект — нужны бак, помпа и вода\n' +
    '💧 Свои баки — нужна вода (помпу добавим, если нет)\n' +
    '🔁 Я уже ваш клиент — заказывал(а) раньше по телефону\n' +
    '⚙️ Другое — чужая тара, нестандарт',

  /** Число баков на руках (ветки «свои баки» и «я уже клиент»). */
  ownTaraCount:
    'Сколько у вас баков (19 л) на руках? Пришлите числом — на столько посчитаем обмен.',

  /** Некорректный ввод числа баков. */
  ownTaraInvalid: 'Нужно число от 1. Сколько у вас баков?',

  /** Выбор помпы в стартовом комплекте (T5). */
  pumpChoice(pumpPrice: number, electroPrice: number): string {
    return (
      'Какая помпа в комплекте?\n' +
      `• Обычная — ${pumpPrice} грн\n` +
      `• Электрическая — ${electroPrice} грн`
    );
  },

  /** Своя тара: есть ли помпа, иначе докупка (T5). */
  ownPumpAsk(pumpPrice: number): string {
    return `Помпа у вас есть? Если нет — добавим к заказу (${pumpPrice} грн).`;
  },

  /** «Другое» — нестандарт, оформляет диспетчер звонком. */
  onboardingToDispatcher(phone: string): string {
    return (
      'Этот случай оформит диспетчер — он свяжется с вами.\n' +
      `Если удобнее — позвоните: ${phone}`
    );
  },

  /** Подпись кнопки «Повторить прошлый заказ» (SPEC §6) со склонением. */
  repeatButton(n: number): string {
    return `🔄 Повторить: ${n} ${bottlesWord(n)}`;
  },

  /**
   * CONFIRM (SPEC §6) — структурированный итог перед созданием заказа.
   * Ветка по quote.kind: STARTER_KIT показывает разбивку стартового комплекта,
   * остальные — цену за бутыль. Адрес — raw + comment в скобках.
   */
  confirm(quote: OrderQuote, address: Address): string {
    const word = bottlesWord(quote.bottles);
    let breakdown: string;
    if (quote.kind === OrderKind.STARTER_KIT) {
      const pump = quote.electro
        ? `электро-помпа ${quote.electroPumpPrice}`
        : `помпа ${quote.pumpPrice}`;
      breakdown =
        `стартовый комплект: залог ${quote.bottles}×${quote.depositPerBottle} + ` +
        `${pump} + вода ${quote.bottles}×${quote.waterStartPrice}`;
    } else if (quote.newTara > 0) {
      // Добор тары: вода по сетке на всё количество + залог за каждый новый бак.
      breakdown =
        `вода ${quote.bottles}×${quote.perBottle ?? 0} + ` +
        `${quote.newTara} нов. бак ×${quote.depositPerBottle} залог`;
    } else {
      breakdown = `по ${quote.perBottle ?? 0} грн`;
    }
    // Докупка помпы к своей таре (OWN_TARA без помпы).
    if (quote.pumpAddon) breakdown += ` + помпа ${quote.pumpPrice}`;
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

  /**
   * Уведомление клиенту о смене статуса заказа диспетчером (SPEC §8).
   * Для CREATED возвращает null — это исходный статус, о нём не уведомляем.
   */
  orderStatusUpdate(order: Order): string | null {
    switch (order.status) {
      case OrderStatus.ACCEPTED:
        return 'Ваш заказ принят ✅ Готовим к доставке.';
      case OrderStatus.DELIVERED:
        return 'Заказ доставлен 🚚 Спасибо, что выбрали нас!';
      case OrderStatus.CANCELLED:
        return 'Ваш заказ отменён. Если это ошибка — свяжитесь с нами.';
      default:
        return null;
    }
  },

  /** Сбой создания заказа — просим повторить (edge §9). */
  orderError:
    'Не удалось оформить заказ 😔 Попробуйте ещё раз или позвоните нам.',

  /** На шагах ввода прислали не текст (фото/гео/голос) — просим текстом. */
  sendAsText: 'Пришлите, пожалуйста, текстом 🙏',

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
      `• от 2 — ${p.priceFrom2} грн/шт\n` +
      `• от 6 — ${p.priceFrom6} грн/шт\n\n` +
      'Первый заказ (стартовый комплект):\n' +
      `• залог ${p.depositPerBottle} грн/бак + помпа ${p.pumpPrice} грн ` +
      `+ старт-вода ${p.waterStartPrice} грн/бак\n\n` +
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
