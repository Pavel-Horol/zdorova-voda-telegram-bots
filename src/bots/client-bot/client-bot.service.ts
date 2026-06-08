import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Bot,
  InlineKeyboard,
  Keyboard,
  session,
  type Context,
  type SessionFlavor,
} from 'grammy';
import { ClientsService } from '../../modules/clients/clients.service';
import { OrdersService } from '../../modules/orders/orders.service';
import { PricingSettingsService } from '../../modules/pricing-settings/pricing-settings.service';
import type { Address } from '../../../generated/prisma/client';
import { texts } from './client-bot.texts';

/** Шаги диалога клиента (SPEC §6). Хранятся в in-memory сессии grammY. */
enum Step {
  AwaitContact = 'AWAIT_CONTACT',
  MainMenu = 'MAIN_MENU',
  AwaitAddress = 'AWAIT_ADDRESS',
  ChooseQty = 'CHOOSE_QTY',
  Confirm = 'CONFIRM',
}

/** Шаги активного сценария заказа — на них действует «Назад»/«Отмена» (SPEC §6). */
const ORDER_FLOW_STEPS: readonly Step[] = [
  Step.AwaitAddress,
  Step.ChooseQty,
  Step.Confirm,
];

interface SessionData {
  step: Step;
  /** Выбранное количество бутылей, переносится из CHOOSE_QTY в CONFIRM. */
  bottles?: number;
  /**
   * Стек предыдущих шагов сценария заказа для кнопки «Назад» (SPEC §6).
   * Пушатся только inline-переходы внутри флоу; reply-кнопки стек обнуляют.
   */
  history: Step[];
}

type BotContext = Context & SessionFlavor<SessionData>;

// Идентификаторы callback-кнопок.
const CB_CONFIRM_YES = 'confirm:yes';
const CB_BACK = 'nav:back';
const CB_CANCEL = 'nav:cancel';

// Подписи reply-кнопок главного меню (они же — ключи текстового роутера).
const BTN_ORDER = '🚰 Заказать воду';
const BTN_HISTORY = '📋 Мои заказы';
const BTN_PRICES = '💰 Цены';
const BTN_CONTACTS = '📞 Связаться';

/** Максимум бутылей кнопками (3+ всё равно идёт по одной цене, SPEC §3.1). */
const MAX_QTY = 5;

const contactKeyboard = new Keyboard()
  .requestContact('📱 Поделиться номером')
  .resized()
  .oneTime();

/** Постоянное reply-меню — глобальная навигация, видна всегда (SPEC §6). */
const mainReplyKeyboard = new Keyboard()
  .text(BTN_ORDER)
  .row()
  .text(BTN_HISTORY)
  .text(BTN_PRICES)
  .row()
  .text(BTN_CONTACTS)
  .resized()
  .persistent();

/** Клавиатура выбора количества: ряд цифр + ряд навигации (SPEC §6). */
const qtyKeyboard = ((): InlineKeyboard => {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= MAX_QTY; n += 1) {
    kb.text(String(n), `qty:${n}`);
  }
  kb.row().text('◀ Назад', CB_BACK).text('❌ Отмена', CB_CANCEL);
  return kb;
})();

/** Под приглашением адреса — только «Отмена» (с первого шага «назад» = выход). */
const addressKeyboard = new InlineKeyboard().text('❌ Отмена', CB_CANCEL);

/** Подтверждение заказа: подтвердить / изменить (= назад) / отмена (SPEC §6). */
const confirmKeyboard = new InlineKeyboard()
  .text('✅ Всё верно, заказываю', CB_CONFIRM_YES)
  .row()
  .text('✏️ Изменить', CB_BACK)
  .text('❌ Отмена', CB_CANCEL);

/**
 * Клиентский бот (SPEC §6): grammY-инстанс на CLIENT_BOT_TOKEN, long polling.
 * FSM реализован поверх in-memory сессии grammY — при перезапуске диалог
 * начинается заново, это приемлемо для MVP (SPEC §9). Доступ к данным — только
 * через сервисы модулей, напрямую в БД бот не ходит (CLAUDE.md §6).
 *
 * Навигация: постоянное reply-меню = глобальные переходы (отменяют активный
 * заказ), inline-кнопки «Назад»/«Отмена» = переходы внутри сценария заказа.
 */
@Injectable()
export class ClientBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientBotService.name);
  private bot?: Bot<BotContext>;

  constructor(
    private readonly config: ConfigService,
    private readonly clients: ClientsService,
    private readonly orders: OrdersService,
    private readonly pricingSettings: PricingSettingsService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('CLIENT_BOT_TOKEN');
    if (!token) {
      this.logger.warn('CLIENT_BOT_TOKEN не задан — клиентский бот не запущен');
      return;
    }

    const bot = new Bot<BotContext>(token);
    bot.use(
      session({
        initial: (): SessionData => ({ step: Step.MainMenu, history: [] }),
      }),
    );
    this.registerHandlers(bot);
    bot.catch((err) => this.logger.error(`client-bot error: ${err.message}`));
    this.bot = bot;

    // start() резолвится только при остановке бота — НЕ await, иначе init зависнет.
    void bot.start({
      onStart: (me) =>
        this.logger.log(`client-bot @${me.username} started (long polling)`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  private registerHandlers(bot: Bot<BotContext>): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.callbackQuery(/^qty:([1-9]\d*)$/, (ctx) => this.onChooseQty(ctx));
    bot.callbackQuery(CB_CONFIRM_YES, (ctx) => this.onConfirmYes(ctx));
    bot.callbackQuery(CB_BACK, (ctx) => this.onBack(ctx));
    bot.callbackQuery(CB_CANCEL, (ctx) => this.onCancel(ctx));
    // message:text регистрируется ПОСЛЕ command('start'), чтобы /start не попадал сюда.
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** /start: известного клиента ведём в меню, нового — на запрос контакта. */
  private async onStart(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;
    const client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      this.resetSession(ctx, Step.AwaitContact);
      await ctx.reply(texts.awaitContact, { reply_markup: contactKeyboard });
      return;
    }
    await this.showMainMenu(ctx, client.name);
  }

  /** Получен контакт: регистрируем клиента и показываем меню (AWAIT_CONTACT). */
  private async onContact(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;
    const contact = ctx.message?.contact;
    if (!contact) return;
    // Принимаем только собственный контакт пользователя (SPEC §9).
    if (contact.user_id !== ctx.from.id) {
      await ctx.reply(texts.foreignContact, { reply_markup: contactKeyboard });
      return;
    }

    let client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      const phone = contact.phone_number.startsWith('+')
        ? contact.phone_number
        : `+${contact.phone_number}`;
      const name =
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
        null;
      client = await this.registerClient(BigInt(ctx.from.id), phone, name);
    }

    await this.showMainMenu(ctx, client.name);
  }

  /**
   * Единая точка обработки текста: сначала reply-кнопки меню (глобальная
   * навигация, SPEC §6), затем — ввод адреса на шаге AwaitAddress. Совпадение
   * с кнопкой имеет приоритет, поэтому «💰 Цены» не сохранится как адрес.
   */
  private async onText(ctx: BotContext): Promise<void> {
    const raw = ctx.message?.text?.trim();
    if (!raw) return;

    switch (raw) {
      case BTN_ORDER:
        await this.startOrder(ctx);
        return;
      case BTN_HISTORY:
        await this.showHistory(ctx);
        return;
      case BTN_PRICES:
        await this.showPrices(ctx);
        return;
      case BTN_CONTACTS:
        await this.showContacts(ctx);
        return;
      default:
        break;
    }

    if (ctx.session.step !== Step.AwaitAddress) return;
    const client = await this.requireClient(ctx);
    if (!client) return;

    await this.clients.addAddress(client.id, { raw, isDefault: true });
    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) return;
    this.pushHistory(ctx, Step.AwaitAddress);
    await this.renderChooseQty(ctx);
  }

  /**
   * «Заказать воду»: глобальный вход в сценарий. Сбрасывает прошлый флоу,
   * затем — нет адреса → собираем (первый заказ), есть → к выбору количества.
   */
  private async startOrder(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;

    ctx.session.bottles = undefined;
    ctx.session.history = [Step.MainMenu];

    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    await this.renderChooseQty(ctx);
  }

  /** «Мои заказы»: последние заказы клиента (SPEC §6). Прерывает активный заказ. */
  private async showHistory(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const orders = await this.orders.listByClient(client.id);
    const text = orders.length ? texts.history(orders) : texts.historyEmpty;
    await ctx.reply(text, { reply_markup: mainReplyKeyboard });
  }

  /** «Цены»: текущая сетка из PriceSettings (SPEC §6). Прерывает активный заказ. */
  private async showPrices(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const prices = await this.pricingSettings.getCurrent();
    await ctx.reply(texts.prices(prices), { reply_markup: mainReplyKeyboard });
  }

  /** «Связаться»: телефон поддержки из конфига (SPEC §6, §11). */
  private async showContacts(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const phone =
      this.config.get<string>('SUPPORT_PHONE') ?? '(телефон уточняется)';
    await ctx.reply(texts.contacts(phone), { reply_markup: mainReplyKeyboard });
  }

  /** Выбрано количество: считаем превью суммы и показываем подтверждение. */
  private async onChooseQty(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.ChooseQty) return;
    const bottles = Number(ctx.match?.[1]);
    if (!Number.isInteger(bottles) || bottles < 1) return;

    const client = await this.requireClient(ctx);
    if (!client) return;
    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      await this.renderAddressPrompt(ctx);
      return;
    }

    ctx.session.bottles = bottles;
    this.pushHistory(ctx, Step.ChooseQty);
    await this.renderConfirm(ctx, client.id, address);
  }

  /** Подтверждение заказа. Шаг уводится из Confirm сразу — защита от двойного тапа. */
  private async onConfirmYes(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Confirm) return; // идемпотентность (SPEC §9)
    const bottles = ctx.session.bottles;

    const client = await this.requireClient(ctx);
    if (!client) return;
    if (!bottles) {
      await this.showMainMenu(ctx, client.name);
      return;
    }
    // Уводим из Confirm ДО создания заказа — повторный тап не создаст дубль.
    this.resetSession(ctx, Step.MainMenu);

    await this.orders.createOrder(client.id, bottles);
    await ctx.reply(texts.orderDone, { reply_markup: mainReplyKeyboard });
  }

  /** «Назад» (в т.ч. «Изменить» на Confirm): шаг назад по стеку истории. */
  private async onBack(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;

    const prev = ctx.session.history.pop();
    if (!prev || prev === Step.MainMenu) {
      await this.showMainMenu(ctx, client.name);
      return;
    }
    if (prev === Step.AwaitAddress) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    // prev === ChooseQty: вернуться к выбору количества.
    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    await this.renderChooseQty(ctx);
  }

  /** «Отмена»: выход из сценария заказа в главное меню. */
  private async onCancel(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.resetSession(ctx, Step.MainMenu);
    await ctx.reply(texts.orderCancelled, { reply_markup: mainReplyKeyboard });
  }

  // --- Render-хелперы экранов: ставят шаг и отрисовывают (SPEC §6) -----------

  private async showMainMenu(
    ctx: BotContext,
    name: string | null,
  ): Promise<void> {
    this.resetSession(ctx, Step.MainMenu);
    await ctx.reply(texts.mainMenu(name), { reply_markup: mainReplyKeyboard });
  }

  private async renderAddressPrompt(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.AwaitAddress;
    await ctx.reply(texts.awaitAddress, { reply_markup: addressKeyboard });
  }

  private async renderChooseQty(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.ChooseQty;
    await ctx.reply(texts.chooseQty, { reply_markup: qtyKeyboard });
  }

  private async renderConfirm(
    ctx: BotContext,
    clientId: string,
    address: Address,
  ): Promise<void> {
    const bottles = ctx.session.bottles;
    if (!bottles) {
      await this.renderChooseQty(ctx);
      return;
    }
    const quote = await this.orders.quote(clientId, bottles);
    ctx.session.step = Step.Confirm;
    await ctx.reply(texts.confirm(quote, address), {
      reply_markup: confirmKeyboard,
    });
  }

  // --- Управление сессией ---------------------------------------------------

  /** Сбрасывает локальное состояние сценария и ставит указанный шаг. */
  private resetSession(ctx: BotContext, step: Step): void {
    ctx.session.step = step;
    ctx.session.bottles = undefined;
    ctx.session.history = [];
  }

  /**
   * Уход из активного сценария заказа по reply-кнопке (SPEC §6): если шёл заказ,
   * считаем его отменённым (Order ещё не создан — сбрасываем только сессию).
   */
  private leaveOrderFlow(ctx: BotContext): void {
    if (ORDER_FLOW_STEPS.includes(ctx.session.step)) {
      this.resetSession(ctx, Step.MainMenu);
    }
  }

  private pushHistory(ctx: BotContext, step: Step): void {
    ctx.session.history.push(step);
  }

  /**
   * Достаёт клиента по telegramId; если бот его не знает (потеря сессии,
   * прямой тап по старой кнопке) — возвращает к запросу контакта.
   */
  private async requireClient(ctx: BotContext) {
    if (!ctx.from) return null;
    const client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      this.resetSession(ctx, Step.AwaitContact);
      await ctx.reply(texts.awaitContact, { reply_markup: contactKeyboard });
      return null;
    }
    return client;
  }

  /** Регистрация клиента; если телефон уже знаком — переиспользуем (edge §9). */
  private async registerClient(
    telegramId: bigint,
    phone: string,
    name: string | null,
  ) {
    const existing = await this.clients.findByPhone(phone);
    if (existing) return existing;
    return this.clients.create({ telegramId, phone, name });
  }
}
