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
import { texts } from './client-bot.texts';

/** Шаги диалога клиента (SPEC §6). Хранятся в in-memory сессии grammY. */
enum Step {
  AwaitContact = 'AWAIT_CONTACT',
  MainMenu = 'MAIN_MENU',
  AwaitAddress = 'AWAIT_ADDRESS',
  ChooseQty = 'CHOOSE_QTY',
  Confirm = 'CONFIRM',
}

interface SessionData {
  step: Step;
  /** Выбранное количество бутылей, переносится из CHOOSE_QTY в CONFIRM. */
  bottles?: number;
}

type BotContext = Context & SessionFlavor<SessionData>;

// Идентификаторы callback-кнопок.
const CB_ORDER = 'order';
const CB_CONFIRM_YES = 'confirm:yes';
const CB_CONFIRM_NO = 'confirm:no';

/** Максимум бутылей кнопками (3+ всё равно идёт по одной цене, SPEC §3.1). */
const MAX_QTY = 5;

const contactKeyboard = new Keyboard()
  .requestContact('📱 Поделиться номером')
  .resized()
  .oneTime();

const mainMenuKeyboard = new InlineKeyboard().text(
  '🚰 Заказать воду',
  CB_ORDER,
);

const qtyKeyboard = ((): InlineKeyboard => {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= MAX_QTY; n += 1) {
    kb.text(String(n), `qty:${n}`);
  }
  return kb;
})();

const confirmKeyboard = new InlineKeyboard()
  .text('✅ Подтвердить', CB_CONFIRM_YES)
  .text('❌ Отмена', CB_CONFIRM_NO);

/**
 * Клиентский бот (SPEC §6): grammY-инстанс на CLIENT_BOT_TOKEN, long polling.
 * FSM реализован поверх in-memory сессии grammY — при перезапуске диалог
 * начинается заново, это приемлемо для MVP (SPEC §9). Доступ к данным — только
 * через ClientsService/OrdersService, напрямую в БД бот не ходит (CLAUDE.md §6).
 */
@Injectable()
export class ClientBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientBotService.name);
  private bot?: Bot<BotContext>;

  constructor(
    private readonly config: ConfigService,
    private readonly clients: ClientsService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('CLIENT_BOT_TOKEN');
    if (!token) {
      this.logger.warn('CLIENT_BOT_TOKEN не задан — клиентский бот не запущен');
      return;
    }

    const bot = new Bot<BotContext>(token);
    bot.use(session({ initial: (): SessionData => ({ step: Step.MainMenu }) }));
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
    bot.callbackQuery(CB_ORDER, (ctx) => this.onOrder(ctx));
    bot.callbackQuery(/^qty:([1-9]\d*)$/, (ctx) => this.onChooseQty(ctx));
    bot.callbackQuery(CB_CONFIRM_YES, (ctx) => this.onConfirmYes(ctx));
    bot.callbackQuery(CB_CONFIRM_NO, (ctx) => this.onConfirmNo(ctx));
    // message:text регистрируется ПОСЛЕ command('start'), чтобы /start не попадал сюда.
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** /start: известного клиента ведём в меню, нового — на запрос контакта. */
  private async onStart(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;
    const client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      ctx.session.step = Step.AwaitContact;
      await ctx.reply(texts.awaitContact, { reply_markup: contactKeyboard });
      return;
    }
    ctx.session.step = Step.MainMenu;
    await ctx.reply(texts.mainMenu(client.name), {
      reply_markup: mainMenuKeyboard,
    });
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

    ctx.session.step = Step.MainMenu;
    await ctx.reply(texts.mainMenu(client.name), {
      reply_markup: mainMenuKeyboard,
    });
  }

  /** «Заказать воду»: нет адреса → собираем (первый заказ), есть → к выбору кол-ва. */
  private async onOrder(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;

    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      ctx.session.step = Step.AwaitAddress;
      await ctx.reply(texts.awaitAddress, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    ctx.session.step = Step.ChooseQty;
    await ctx.reply(texts.chooseQty, { reply_markup: qtyKeyboard });
  }

  /** Текстовое сообщение трактуем как адрес только на шаге AWAIT_ADDRESS. */
  private async onText(ctx: BotContext): Promise<void> {
    if (ctx.session.step !== Step.AwaitAddress) return;
    const raw = ctx.message?.text?.trim();
    if (!raw) return;
    const client = await this.requireClient(ctx);
    if (!client) return;

    await this.clients.addAddress(client.id, { raw, isDefault: true });
    ctx.session.step = Step.ChooseQty;
    await ctx.reply(texts.chooseQty, { reply_markup: qtyKeyboard });
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
      ctx.session.step = Step.AwaitAddress;
      await ctx.reply(texts.awaitAddress, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    const quote = await this.orders.quote(client.id, bottles);
    ctx.session.bottles = bottles;
    ctx.session.step = Step.Confirm;
    await ctx.reply(texts.confirm(quote, address.raw), {
      reply_markup: confirmKeyboard,
    });
  }

  /** Подтверждение заказа. Шаг уводится из Confirm сразу — защита от двойного тапа. */
  private async onConfirmYes(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Confirm) return; // идемпотентность (SPEC §9)
    const bottles = ctx.session.bottles;
    ctx.session.step = Step.MainMenu;
    ctx.session.bottles = undefined;

    const client = await this.requireClient(ctx);
    if (!client) return;
    if (!bottles) {
      await ctx.reply(texts.mainMenu(client.name), {
        reply_markup: mainMenuKeyboard,
      });
      return;
    }

    await this.orders.createOrder(client.id, bottles);
    await ctx.reply(texts.orderDone, { reply_markup: mainMenuKeyboard });
  }

  /** Отказ от подтверждения — назад в меню. */
  private async onConfirmNo(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    ctx.session.step = Step.MainMenu;
    ctx.session.bottles = undefined;
    await ctx.reply(texts.orderCancelled, { reply_markup: mainMenuKeyboard });
  }

  /**
   * Достаёт клиента по telegramId; если бот его не знает (потеря сессии,
   * прямой тап по старой кнопке) — возвращает к запросу контакта.
   */
  private async requireClient(ctx: BotContext) {
    if (!ctx.from) return null;
    const client = await this.clients.findByTelegramId(BigInt(ctx.from.id));
    if (!client) {
      ctx.session.step = Step.AwaitContact;
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
