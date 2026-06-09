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
import { OnEvent } from '@nestjs/event-emitter';
import { ClientsService } from '../../modules/clients/clients.service';
import { OrdersService } from '../../modules/orders/orders.service';
import { PricingSettingsService } from '../../modules/pricing-settings/pricing-settings.service';
import {
  ORDER_STATUS_CHANGED,
  type OrderStatusChangedEvent,
} from '../../modules/orders/order-events';
import type { Address, Order } from '../../../generated/prisma/client';
import { OrderStatus } from '../../../generated/prisma/enums';
import { texts } from './client-bot.texts';

/** Шаги диалога клиента (SPEC §6). Хранятся в in-memory сессии grammY. */
enum Step {
  AwaitContact = 'AWAIT_CONTACT',
  MainMenu = 'MAIN_MENU',
  AwaitAddress = 'AWAIT_ADDRESS',
  AwaitComment = 'AWAIT_COMMENT',
  ChooseQty = 'CHOOSE_QTY',
  Confirm = 'CONFIRM',
}

/** Шаги активного сценария заказа — на них действует «Назад»/«Отмена» (SPEC §6). */
const ORDER_FLOW_STEPS: readonly Step[] = [
  Step.AwaitAddress,
  Step.AwaitComment,
  Step.ChooseQty,
  Step.Confirm,
];

interface SessionData {
  step: Step;
  /** Выбранное количество бутылей, переносится из CHOOSE_QTY в CONFIRM. */
  bottles?: number;
  /**
   * Адрес (raw), введённый на AWAIT_ADDRESS, до сбора комментария на
   * AWAIT_COMMENT. Address создаётся одной записью только после шага комментария.
   */
  addressRaw?: string;
  /**
   * Стек предыдущих шагов сценария заказа для кнопки «Назад» (SPEC §6).
   * Пушатся только inline-переходы внутри флоу; reply-кнопки стек обнуляют.
   */
  history: Step[];
  /**
   * message_id последнего отправленного inline-экрана сценария. При любом
   * переходе с него снимаем клавиатуру, чтобы в чате не висели «мёртвые» кнопки
   * (тап по ним и так заблокирован гардами по step, но визуально путает).
   */
  activeInlineMessageId?: number;
}

type BotContext = Context & SessionFlavor<SessionData>;

// Идентификаторы callback-кнопок.
const CB_CONFIRM_YES = 'confirm:yes';
const CB_BACK = 'nav:back';
const CB_CANCEL = 'nav:cancel';
const CB_SKIP = 'nav:skip';

// Подписи reply-кнопок главного меню (они же — ключи текстового роутера).
const BTN_ORDER = '🚰 Заказать воду';
const BTN_HISTORY = '📋 Мои заказы';
const BTN_PRICES = '💰 Цены';
const BTN_CONTACTS = '📞 Связаться';

/** Максимум бутылей кнопками (3+ всё равно идёт по одной цене, SPEC §3.1). */
const MAX_QTY = 5;

/**
 * Верхняя граница объёма заказа. Кнопки дают максимум MAX_QTY (или повтор
 * реального прошлого заказа), так что больше — это подделанный callback. Защита
 * от абсурдных сумм; реальные большие заказы — звонком диспетчеру (SPEC §1).
 */
const MAX_ORDER_QTY = 100;

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

/**
 * Клавиатура выбора количества (SPEC §6): опц. кнопка «Повторить прошлый заказ»,
 * ряд цифр 1..MAX_QTY, ряд навигации. Кнопка повтора шлёт тот же `qty:N`, что и
 * цифры, поэтому отдельного обработчика не нужно (N может быть и больше MAX_QTY).
 */
function buildQtyKeyboard(repeatN: number | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (repeatN) {
    kb.text(texts.repeatButton(repeatN), `qty:${repeatN}`).row();
  }
  for (let n = 1; n <= MAX_QTY; n += 1) {
    kb.text(String(n), `qty:${n}`);
  }
  kb.row().text('◀ Назад', CB_BACK).text('❌ Отмена', CB_CANCEL);
  return kb;
}

/**
 * Кнопки отмены под списком «Мои заказы»: по одной на заказ в статусе CREATED
 * (диспетчер ещё не принял — клиент может отменить сам, SPEC §9). Если отменять
 * нечего — undefined (список идёт обычным текстом без inline-клавиатуры).
 */
function buildHistoryKeyboard(orders: Order[]): InlineKeyboard | undefined {
  const cancellable = orders.filter((o) => o.status === OrderStatus.CREATED);
  if (!cancellable.length) return undefined;
  const kb = new InlineKeyboard();
  for (const o of cancellable) {
    kb.text(`❌ Отменить #${o.id.slice(0, 8)}`, `ocancel:${o.id}`).row();
  }
  return kb;
}

/** Под приглашением адреса — только «Отмена» (с первого шага «назад» = выход). */
const addressKeyboard = new InlineKeyboard().text('❌ Отмена', CB_CANCEL);

/** Под приглашением комментария к адресу: пропустить (комментарий не обязателен) / отмена. */
const commentKeyboard = new InlineKeyboard()
  .text('⏭ Пропустить', CB_SKIP)
  .text('❌ Отмена', CB_CANCEL);

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

  /**
   * Уведомляет клиента о смене статуса его заказа диспетчером (SPEC §8).
   * Слушает событие из OrdersService. Сбой отправки (клиент заблокировал бота,
   * удалил чат) логируем, но не пробрасываем — это не должно ронять переход
   * статуса у диспетчера (CLAUDE.md прав. 9).
   */
  @OnEvent(ORDER_STATUS_CHANGED)
  async onOrderStatusChanged(event: OrderStatusChangedEvent): Promise<void> {
    if (!this.bot) return;
    const text = texts.orderStatusUpdate(event.order);
    if (!text) return;
    // Слушатель работает fire-and-forget (emit не ждёт): любую ошибку (БД,
    // заблокированный бот) гасим здесь, иначе будет unhandled rejection.
    try {
      const client = await this.clients.getById(event.order.clientId);
      if (!client) return;
      await this.bot.api.sendMessage(String(client.telegramId), text);
    } catch (err) {
      this.logger.warn(
        `не удалось уведомить клиента по заказу ${event.order.id}: ${(err as Error).message}`,
      );
    }
  }

  private registerHandlers(bot: Bot<BotContext>): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.callbackQuery(/^qty:([1-9]\d*)$/, (ctx) => this.onChooseQty(ctx));
    bot.callbackQuery(CB_CONFIRM_YES, (ctx) => this.onConfirmYes(ctx));
    bot.callbackQuery(CB_BACK, (ctx) => this.onBack(ctx));
    bot.callbackQuery(CB_CANCEL, (ctx) => this.onCancel(ctx));
    bot.callbackQuery(CB_SKIP, (ctx) => this.onSkipComment(ctx));
    bot.callbackQuery(/^ocancel:(.+)$/, (ctx) => this.onCancelOwnOrder(ctx));
    // message:text регистрируется ПОСЛЕ command('start'), чтобы /start не попадал сюда.
    bot.on('message:text', (ctx) => this.onText(ctx));
    // Фоллбэк для НЕ-текстовых сообщений (фото/гео/стикер): ловится последним,
    // т.к. text/contact-хендлеры выше обрывают цепочку для своих типов.
    bot.on('message', (ctx) => this.onNonTextMessage(ctx));
  }

  /** /start: известного клиента ведём в меню, нового — на запрос контакта. */
  private async onStart(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;
    const client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      this.resetSession(ctx, Step.AwaitContact);
      await this.replyMenu(ctx, texts.awaitContact, contactKeyboard);
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
      await this.replyMenu(ctx, texts.foreignContact, contactKeyboard);
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
   * навигация, SPEC §6), затем — ввод адреса (AwaitAddress) или комментария
   * (AwaitComment). Совпадение с кнопкой имеет приоритет, поэтому «💰 Цены» не
   * сохранится как адрес/комментарий.
   */
  private async onText(ctx: BotContext): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    switch (text) {
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

    if (ctx.session.step === Step.AwaitAddress) {
      await this.onAddressInput(ctx, text);
    } else if (ctx.session.step === Step.AwaitComment) {
      await this.finalizeAddress(ctx, text);
    }
  }

  /**
   * Не-текстовое сообщение (фото, гео, голос, стикер). Если ждём адрес или
   * комментарий — мягко просим прислать текстом (активный экран с «Отмена» не
   * трогаем, чтобы из него можно было выйти). В остальных состояниях — игнор.
   */
  private async onNonTextMessage(ctx: BotContext): Promise<void> {
    const step = ctx.session.step;
    if (step === Step.AwaitAddress || step === Step.AwaitComment) {
      await ctx.reply(texts.sendAsText);
    }
  }

  /** Введён адрес (AWAIT_ADDRESS): запоминаем raw и идём собирать комментарий. */
  private async onAddressInput(ctx: BotContext, raw: string): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    ctx.session.addressRaw = raw;
    this.pushHistory(ctx, Step.AwaitAddress);
    await this.renderCommentPrompt(ctx);
  }

  /** «Пропустить» комментарий (AWAIT_COMMENT): создаём адрес без комментария. */
  private async onSkipComment(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.AwaitComment) return;
    await this.finalizeAddress(ctx, null);
  }

  /**
   * Завершает сбор адреса: создаёт default-адрес с (опц.) комментарием и ведёт
   * к выбору количества. addressRaw остаётся в сессии до выхода из сценария
   * (resetSession), чтобы «Назад» на шаг комментария снова имел адрес.
   */
  private async finalizeAddress(
    ctx: BotContext,
    comment: string | null,
  ): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    const raw = ctx.session.addressRaw;
    if (!raw) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    // upsert, а не create: повторный проход шага (возврат «Назад») не плодит дубли.
    await this.clients.setDefaultAddress(client.id, { raw, comment });
    this.pushHistory(ctx, Step.AwaitComment);
    await this.renderChooseQty(ctx, client.id);
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
    await this.renderChooseQty(ctx, client.id);
  }

  /**
   * «Мои заказы»: последние заказы клиента (SPEC §6). Прерывает активный заказ.
   * Под заказами в статусе CREATED — кнопки отмены (SPEC §9); если их нет,
   * список идёт обычным текстом с reply-меню.
   */
  private async showHistory(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const orders = await this.orders.listByClient(client.id);
    const text = orders.length ? texts.history(orders) : texts.historyEmpty;
    const kb = buildHistoryKeyboard(orders);
    if (kb) await this.replyInline(ctx, text, kb);
    else await this.replyMenu(ctx, text);
  }

  /**
   * Отмена своего заказа из списка (SPEC §9). Владелец и статус проверяются в
   * сервисе; здесь — тост о результате и перерисовка списка на месте.
   */
  private async onCancelOwnOrder(ctx: BotContext): Promise<void> {
    const orderId = ctx.match?.[1];
    const client = await this.requireClient(ctx);
    if (!client || !orderId) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.orders.cancelOwnOrder(orderId, client.id);
    } catch {
      // Уже принят/доставлен/чужой — отменить нельзя.
      await ctx.answerCallbackQuery({ text: 'Этот заказ уже нельзя отменить' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Заказ отменён' });

    // Перерисовываем список на месте под актуальные статусы и кнопки.
    const orders = await this.orders.listByClient(client.id);
    const text = orders.length ? texts.history(orders) : texts.historyEmpty;
    const kb = buildHistoryKeyboard(orders);
    try {
      await ctx.editMessageText(text, kb ? { reply_markup: kb } : undefined);
      if (!kb) ctx.session.activeInlineMessageId = undefined;
    } catch {
      // Сообщение слишком старое для правки — клиент уже увидел тост «отменён».
    }
  }

  /** «Цены»: текущая сетка из PriceSettings (SPEC §6). Прерывает активный заказ. */
  private async showPrices(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const prices = await this.pricingSettings.getCurrent();
    await this.replyMenu(ctx, texts.prices(prices));
  }

  /** «Связаться»: телефон поддержки из конфига (SPEC §6, §11). */
  private async showContacts(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const phone =
      this.config.get<string>('SUPPORT_PHONE') ?? '(телефон уточняется)';
    await this.replyMenu(ctx, texts.contacts(phone));
  }

  /** Выбрано количество: считаем превью суммы и показываем подтверждение. */
  private async onChooseQty(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.ChooseQty) return;
    const bottles = Number(ctx.match?.[1]);
    if (!Number.isInteger(bottles) || bottles < 1) return;
    // Защита от подделанного callback'а (UI даёт максимум MAX_QTY/повтор реального
    // заказа). Аномально большой объём — на телефон диспетчеру, не через бота.
    if (bottles > MAX_ORDER_QTY) return;

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

    try {
      await this.orders.createOrder(client.id, bottles);
    } catch (err) {
      // Сбой создания (БД/гонка) — не молчим: клиент должен понять, что заказ
      // не оформлен, и повторить (выбор кол-ва уже сброшен — оформит заново).
      this.logger.error(
        `createOrder failed for client ${client.id}: ${(err as Error).message}`,
      );
      await this.replyMenu(ctx, texts.orderError);
      return;
    }
    await this.replyMenu(ctx, texts.orderDone);
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
    if (prev === Step.AwaitComment) {
      await this.renderCommentPrompt(ctx);
      return;
    }
    // prev === ChooseQty: вернуться к выбору количества.
    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    await this.renderChooseQty(ctx, client.id);
  }

  /** «Отмена»: выход из сценария заказа в главное меню. */
  private async onCancel(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.resetSession(ctx, Step.MainMenu);
    await this.replyMenu(ctx, texts.orderCancelled);
  }

  // --- Render-хелперы экранов: ставят шаг и отрисовывают (SPEC §6) -----------

  private async showMainMenu(
    ctx: BotContext,
    name: string | null,
  ): Promise<void> {
    this.resetSession(ctx, Step.MainMenu);
    await this.replyMenu(ctx, texts.mainMenu(name));
  }

  private async renderAddressPrompt(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.AwaitAddress;
    await this.replyInline(ctx, texts.awaitAddress, addressKeyboard);
  }

  private async renderCommentPrompt(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.AwaitComment;
    await this.replyInline(ctx, texts.awaitComment, commentKeyboard);
  }

  private async renderChooseQty(
    ctx: BotContext,
    clientId: string,
  ): Promise<void> {
    ctx.session.step = Step.ChooseQty;
    const repeatN = await this.orders.lastBottles(clientId);
    await this.replyInline(ctx, texts.chooseQty, buildQtyKeyboard(repeatN));
  }

  private async renderConfirm(
    ctx: BotContext,
    clientId: string,
    address: Address,
  ): Promise<void> {
    const bottles = ctx.session.bottles;
    if (!bottles) {
      await this.renderChooseQty(ctx, clientId);
      return;
    }
    const quote = await this.orders.quote(clientId, bottles);
    ctx.session.step = Step.Confirm;
    await this.replyInline(ctx, texts.confirm(quote, address), confirmKeyboard);
  }

  // --- Отправка экранов с очисткой висящих inline-кнопок --------------------

  /**
   * Inline-экран сценария: гасит клавиатуру прошлого экрана и запоминает
   * message_id нового, чтобы при следующем переходе снять кнопки и с него.
   */
  private async replyInline(
    ctx: BotContext,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    await this.clearActiveInline(ctx);
    const msg = await ctx.reply(text, { reply_markup: keyboard });
    ctx.session.activeInlineMessageId = msg.message_id;
  }

  /**
   * Экран с reply-меню (или запросом контакта): гасит висящую inline-клавиатуру
   * сценария. Свой message_id не запоминаем — у reply-клавиатуры её нет.
   */
  private async replyMenu(
    ctx: BotContext,
    text: string,
    keyboard: Keyboard = mainReplyKeyboard,
  ): Promise<void> {
    await this.clearActiveInline(ctx);
    await ctx.reply(text, { reply_markup: keyboard });
  }

  /**
   * Снимает inline-клавиатуру с последнего экрана сценария (если он был).
   * Ошибку (сообщение удалено/слишком старое) глотаем — это не критично.
   */
  private async clearActiveInline(ctx: BotContext): Promise<void> {
    const id = ctx.session.activeInlineMessageId;
    ctx.session.activeInlineMessageId = undefined;
    if (id === undefined || !ctx.chat) return;
    try {
      await ctx.api.editMessageReplyMarkup(ctx.chat.id, id);
    } catch {
      // сообщение уже удалено/недоступно — игнорируем
    }
  }

  // --- Управление сессией ---------------------------------------------------

  /**
   * Сбрасывает локальное состояние сценария и ставит указанный шаг.
   * `activeInlineMessageId` НЕ трогаем — им управляют replyInline/replyMenu,
   * иначе мы потеряли бы id до того, как сняли с сообщения клавиатуру.
   */
  private resetSession(ctx: BotContext, step: Step): void {
    ctx.session.step = step;
    ctx.session.bottles = undefined;
    ctx.session.addressRaw = undefined;
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
      await this.replyMenu(ctx, texts.awaitContact, contactKeyboard);
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
