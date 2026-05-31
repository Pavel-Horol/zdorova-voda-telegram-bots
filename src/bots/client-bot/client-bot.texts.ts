import type { OrderQuote } from '../../modules/orders/orders.service';

/**
 * Тексты экранов клиентского бота (SPEC §6). Чистые функции без побочных
 * эффектов — деньги и количества приходят готовыми из OrderQuote (CLAUDE.md §1).
 */
export const texts = {
  /** AWAIT_CONTACT (SPEC §6). */
  awaitContact:
    'Привет! 💧 Чтобы оформить заказ, поделитесь номером телефона — ' +
    'по нему мы определим ваш адрес доставки.',

  /** Главное меню для уже известного клиента. */
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

  /** CONFIRM_FIRST / CONFIRM_REPEAT (SPEC §6) — выбирается по quote.isFirstOrder. */
  confirm(quote: OrderQuote, address: string): string {
    if (quote.isFirstOrder) {
      return (
        'Первый заказ включает помпу и бутыли (вода — бесплатно).\n' +
        `${quote.bottles} бутыл(ей): ${quote.bottles}×${quote.depositPerBottle} + ` +
        `помпа ${quote.pumpPrice} = ${quote.totalPrice} грн.\n` +
        `Адрес: ${address}\n` +
        'Оплата водителю при доставке. Подтверждаете?'
      );
    }
    return (
      `${quote.bottles} бутыл(ей) × ${quote.perBottle ?? 0} грн = ${quote.totalPrice} грн.\n` +
      `Адрес: ${address}\n` +
      'Оплата водителю. Подтверждаете?'
    );
  },

  /** ORDER_DONE (SPEC §6). */
  orderDone: 'Заказ принят ✅ Скоро с вами свяжутся / привезут воду. Спасибо!',

  /** Отказ от подтверждения — возврат в меню. */
  orderCancelled: 'Заказ отменён. Можно оформить заново в любой момент.',

  /** Клиент прислал не свой контакт (edge-кейс SPEC §9). */
  foreignContact:
    'Нужен именно ваш номер. Нажмите кнопку «Поделиться номером» ниже 🙏',
} as const;
