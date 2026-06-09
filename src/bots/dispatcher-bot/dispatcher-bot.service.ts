import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keyboard, session } from 'grammy';
import { OrdersService } from '../../modules/orders/orders.service';
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
  dispatcherWelcome,
  orderKeyboard,
  orderMessage,
  priceFieldLabel,
  pricesKeyboard,
  pricesMessage,
} from './dispatcher-bot.texts';

// Подписи reply-кнопок постоянного меню (они же — ключи текстового роутера).
const BTN_PRICES = '💰 Цены';
const BTN_STATS = '📊 Статистика';

/** Постоянное reply-меню диспетчера — всегда внизу экрана (по образцу клиента). */
const dispatcherMenuKeyboard = new Keyboard()
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
    bot.command('prices', (ctx) => this.onPrices(ctx));
    bot.command('stats', (ctx) => this.onStats(ctx));
    bot.callbackQuery(/^acc:(.+)$/, (ctx) => this.onTransition(ctx, 'accept'));
    bot.callbackQuery(/^del:(.+)$/, (ctx) => this.onTransition(ctx, 'deliver'));
    bot.callbackQuery(/^can:(.+)$/, (ctx) => this.onTransition(ctx, 'cancel'));
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

  /** /prices — текущие цены + кнопки выбора поля для редактирования. */
  private async onPrices(ctx: DispatcherContext): Promise<void> {
    // Сбрасываем незавершённое редактирование: повторный вход в /prices отменяет
    // ожидание ввода числа (иначе следующее число ушло бы в прошлое поле).
    ctx.session.editingPriceField = undefined;
    const prices = await this.pricingSettings.getCurrent();
    await ctx.reply(pricesMessage(prices), { reply_markup: pricesKeyboard() });
  }

  /** Выбор поля цены: запоминаем в сессии и ждём число следующим сообщением. */
  private async onPickPriceField(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const field = ctx.match?.[1] as EditablePriceField | undefined;
    if (!field) return;
    ctx.session.editingPriceField = field;
    await ctx.reply(
      `Введите новое значение для «${priceFieldLabel(field)}» (целое число грн):`,
    );
  }

  /**
   * Текст: сначала кнопки постоянного меню (приоритет, чтобы «💰 Цены» не ушло
   * как значение цены), затем — ввод числа на шаге редактирования.
   */
  private async onText(ctx: DispatcherContext): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    if (text === BTN_PRICES) {
      await this.onPrices(ctx);
      return;
    }
    if (text === BTN_STATS) {
      await this.onStats(ctx);
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

  /** /stats — минимальная сводка за сегодня (SPEC §7). */
  private async onStats(ctx: DispatcherContext): Promise<void> {
    const stats = await this.orders.statsToday();
    await ctx.reply(
      `Сегодня: ${stats.count} заказ(ов), сумма ${stats.sum} грн (без отменённых).`,
    );
  }
}
