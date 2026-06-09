import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keyboard, session } from 'grammy';
import {
  OrdersService,
  type OrderWithRelations,
} from '../../modules/orders/orders.service';
import {
  PricingSettingsService,
  type EditablePriceField,
} from '../../modules/pricing-settings/pricing-settings.service';
import {
  DISPATCHER_BOT,
  type DispatcherBot,
  type DispatcherContext,
  type DispatcherSession,
} from './dispatcher-bot.bot';
import {
  activeOrdersHeader,
  dispatcherCommands,
  dispatcherHelp,
  dispatcherWelcome,
  editQuantityPrompt,
  noActiveOrders,
  orderKeyboard,
  orderMessage,
  priceEditCancelKeyboard,
  priceFieldLabel,
  pricesKeyboard,
  pricesMessage,
  statsMessage,
} from './dispatcher-bot.texts';

/** Потолок количества при правке заказа — защита от опечатки (диспетчер доверенный). */
const MAX_EDIT_QTY = 100;

// Подписи reply-кнопок постоянного меню (они же — ключи текстового роутера).
const BTN_ORDERS = '📋 Активные';
const BTN_PRICES = '💰 Цены';
const BTN_STATS = '📊 Статистика';

/** Постоянное reply-меню диспетчера — всегда внизу экрана (по образцу клиента). */
const dispatcherMenuKeyboard = new Keyboard()
  .text(BTN_ORDERS)
  .row()
  .text(BTN_PRICES)
  .text(BTN_STATS)
  .resized()
  .persistent();

/**
 * Диспетчерский бот (SPEC §7): команды /prices, /stats и обработка кнопок под
 * заказами. Использует общий инстанс DISPATCHER_BOT (тот же, что шлёт уведомления
 * из TelegramOrderDispatcher). В БД ходит только через сервисы модулей (§6).
 */
@Injectable()
export class DispatcherBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherBotService.name);

  constructor(
    @Inject(DISPATCHER_BOT) private readonly bot: DispatcherBot | null,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly pricingSettings: PricingSettingsService,
  ) {}

  onModuleInit(): void {
    if (!this.bot) {
      this.logger.warn(
        'DISPATCHER_BOT_TOKEN не задан — диспетчерский бот не запущен',
      );
      return;
    }
    const bot = this.bot;

    bot.use(session({ initial: (): DispatcherSession => ({}) }));
    this.useChatGuard(bot);
    this.registerHandlers(bot);
    bot.catch((err) =>
      this.logger.error(`dispatcher-bot error: ${err.message}`),
    );

    // Меню команд Telegram («/») — независимый API-вызов, не блокируем запуск.
    void bot.api
      .setMyCommands(dispatcherCommands)
      .catch((err: Error) =>
        this.logger.warn(`setMyCommands failed: ${err.message}`),
      );

    // start() резолвится только при остановке — НЕ await, иначе init зависнет.
    void bot.start({
      onStart: (me) =>
        this.logger.log(
          `dispatcher-bot @${me.username} started (long polling)`,
        ),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  /** Пропускаем апдейты только из чата диспетчера (если он задан). */
  private useChatGuard(bot: DispatcherBot): void {
    const allowedChat = this.config.get<string>('DISPATCHER_CHAT_ID');
    if (!allowedChat) return;
    bot.use(async (ctx, next) => {
      if (ctx.chat && String(ctx.chat.id) !== allowedChat) return;
      await next();
    });
  }

  private registerHandlers(bot: DispatcherBot): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('help', (ctx) => this.onHelp(ctx));
    bot.command('orders', (ctx) => this.onActiveOrders(ctx));
    bot.command('prices', (ctx) => this.onPrices(ctx));
    bot.command('stats', (ctx) => this.onStats(ctx));
    bot.callbackQuery(/^acc:(.+)$/, (ctx) => this.onTransition(ctx, 'accept'));
    bot.callbackQuery(/^del:(.+)$/, (ctx) => this.onTransition(ctx, 'deliver'));
    bot.callbackQuery(/^can:(.+)$/, (ctx) => this.onTransition(ctx, 'cancel'));
    bot.callbackQuery(/^edit:(.+)$/, (ctx) => this.onEditOrder(ctx));
    bot.callbackQuery('pe_cancel', (ctx) => this.onCancelPriceEdit(ctx));
    bot.callbackQuery(
      /^pe:(price1|price2|price3plus|depositPerBottle|pumpPrice)$/,
      (ctx) => this.onPickPriceField(ctx),
    );
    // message:text — после команд, чтобы /prices и /stats не попадали сюда.
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** Кнопка под заказом: меняем статус и перерисовываем сообщение. */
  private async onTransition(
    ctx: DispatcherContext,
    action: 'accept' | 'deliver' | 'cancel',
  ): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }

    try {
      if (action === 'accept') await this.orders.acceptOrder(id);
      else if (action === 'deliver') await this.orders.markDelivered(id);
      else await this.orders.cancelOrder(id);
    } catch {
      // Невалидный переход (двойной тап, чужой статус) — не падаем, сообщаем тостом.
      await ctx.answerCallbackQuery({ text: 'Уже обработано или недоступно' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Готово' });
    await this.refreshOrderMessage(ctx, id);
  }

  /** Перерисовывает сообщение заказа под актуальный статус и кнопки. */
  private async refreshOrderMessage(
    ctx: DispatcherContext,
    id: string,
  ): Promise<void> {
    const view = await this.orders.getOrderView(id);
    if (!view) return;
    await ctx.editMessageText(orderMessage(view, view.client, view.address), {
      reply_markup: orderKeyboard(view.id, view.status),
    });
  }

  /** /start — приветствие + постоянное reply-меню (точка входа диспетчера). */
  private async onStart(ctx: DispatcherContext): Promise<void> {
    await ctx.reply(dispatcherWelcome, {
      reply_markup: dispatcherMenuKeyboard,
    });
  }

  /** /help — краткая справка по командам. */
  private async onHelp(ctx: DispatcherContext): Promise<void> {
    await ctx.reply(dispatcherHelp);
  }

  /**
   * /orders (и кнопка «📋 Активные») — рабочая очередь: заказы в статусах
   * created/accepted каждый отдельной карточкой с кнопками действий, чтобы их
   * можно было обработать, даже если исходный пуш уехал вверх по чату.
   */
  private async onActiveOrders(ctx: DispatcherContext): Promise<void> {
    const orders = await this.orders.listActive();
    if (!orders.length) {
      await ctx.reply(noActiveOrders);
      return;
    }
    await ctx.reply(activeOrdersHeader(orders.length));
    for (const order of orders) {
      await ctx.reply(orderMessage(order, order.client, order.address), {
        reply_markup: orderKeyboard(order.id, order.status),
      });
    }
  }

  /** /prices — текущие цены + кнопки выбора поля для редактирования. */
  private async onPrices(ctx: DispatcherContext): Promise<void> {
    // Сбрасываем незавершённое редактирование: повторный вход в /prices отменяет
    // ожидание ввода (иначе следующее число ушло бы в прошлое поле/заказ).
    ctx.session.editingPriceField = undefined;
    ctx.session.editingOrderId = undefined;
    const prices = await this.pricingSettings.getCurrent();
    await ctx.reply(pricesMessage(prices), { reply_markup: pricesKeyboard() });
  }

  /** Выбор поля цены: запоминаем в сессии и ждём число следующим сообщением. */
  private async onPickPriceField(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const field = ctx.match?.[1] as EditablePriceField | undefined;
    if (!field) return;
    ctx.session.editingOrderId = undefined; // режимы ввода взаимоисключающие
    ctx.session.editingPriceField = field;
    await ctx.reply(
      `Введите новое значение для «${priceFieldLabel(field)}» (целое число грн):`,
      { reply_markup: priceEditCancelKeyboard() },
    );
  }

  /** «❌ Отмена» под запросом цены: сбрасываем редактирование. */
  private async onCancelPriceEdit(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (!ctx.session.editingPriceField) return; // уже сохранено/неактуально
    ctx.session.editingPriceField = undefined;
    // editMessageText без reply_markup убирает и кнопку «Отмена».
    await ctx.editMessageText('Изменение цены отменено.');
  }

  /** «✏️ Изменить»: запоминаем заказ и ждём новое количество бутылей текстом. */
  private async onEditOrder(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // режимы ввода взаимоисключающие
    ctx.session.editingOrderId = id;
    await ctx.reply(editQuantityPrompt(id));
  }

  /**
   * Текст: сначала кнопки постоянного меню (приоритет, чтобы «💰 Цены» не ушло
   * как значение цены), затем — ввод числа на шаге редактирования.
   */
  private async onText(ctx: DispatcherContext): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    if (text === BTN_ORDERS) {
      await this.onActiveOrders(ctx);
      return;
    }
    if (text === BTN_PRICES) {
      await this.onPrices(ctx);
      return;
    }
    if (text === BTN_STATS) {
      await this.onStats(ctx);
      return;
    }

    // Ввод нового количества для заказа (✏️ Изменить) — приоритет над ценой.
    if (ctx.session.editingOrderId) {
      await this.applyEditedQuantity(ctx, ctx.session.editingOrderId, text);
      return;
    }

    const field = ctx.session.editingPriceField;
    if (!field) return;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
      await ctx.reply('Нужно целое неотрицательное число. Попробуйте ещё раз.');
      return;
    }

    const updated = await this.pricingSettings.update(field, value);
    ctx.session.editingPriceField = undefined;
    await ctx.reply(`Сохранено ✅\n\n${pricesMessage(updated)}`, {
      reply_markup: pricesKeyboard(),
    });
  }

  /** Парсит количество и применяет правку заказа; на ошибке — ждём повторно. */
  private async applyEditedQuantity(
    ctx: DispatcherContext,
    orderId: string,
    text: string,
  ): Promise<void> {
    const bottles = Number(text);
    if (!Number.isInteger(bottles) || bottles < 1 || bottles > MAX_EDIT_QTY) {
      await ctx.reply(
        `Нужно целое число от 1 до ${MAX_EDIT_QTY}. Попробуйте ещё раз.`,
      );
      return;
    }
    let view: OrderWithRelations;
    try {
      view = await this.orders.editQuantity(orderId, bottles);
    } catch {
      // Заказ уже доставлен/отменён/удалён — правка недоступна.
      ctx.session.editingOrderId = undefined;
      await ctx.reply('Этот заказ уже нельзя изменить.');
      return;
    }
    ctx.session.editingOrderId = undefined;
    await ctx.reply(
      `Изменено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status) },
    );
  }

  /** /stats — сводка за сегодня и за неделю (SPEC §7). */
  private async onStats(ctx: DispatcherContext): Promise<void> {
    const stats = await this.orders.stats();
    await ctx.reply(statsMessage(stats));
  }
}
