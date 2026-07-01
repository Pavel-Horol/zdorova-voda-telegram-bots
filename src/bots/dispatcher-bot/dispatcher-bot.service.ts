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
import { ClientsService } from '../../modules/clients/clients.service';
import {
  PricingSettingsService,
  type EditablePriceField,
} from '../../modules/pricing-settings/pricing-settings.service';
import {
  DISPATCHER_BOT,
  dispatcherChatIds,
  type DispatcherBot,
  type DispatcherContext,
  type DispatcherSession,
} from './dispatcher-bot.bot';
import {
  activeOrdersHeader,
  dispatcherCommands,
  dispatcherHelp,
  clientCardMessage,
  clientLookupPrompt,
  dispatcherWelcome,
  driverLine,
  editClaimPrompt,
  editQuantityPrompt,
  geoTagPrompt,
  noActiveOrders,
  noClientFound,
  orderKeyboard,
  orderMessage,
  priceEditCancelKeyboard,
  priceFieldLabel,
  pricesKeyboard,
  pricesMessage,
  statsMessage,
} from './dispatcher-bot.texts';
import {
  BTN_CLIENT,
  BTN_ORDERS,
  BTN_PRICES,
  BTN_STATS,
  parseEditedQuantity,
  parseGeoInput,
  parsePriceValue,
  phoneSearchToken,
  routeDispatcherText,
} from './dispatcher-bot.fsm';

/** Quantity cap when editing an order — guard against a typo (dispatcher is trusted). */
const MAX_EDIT_QTY = 100;

/** Persistent dispatcher reply menu — always at the bottom (mirrors the client's). */
const dispatcherMenuKeyboard = new Keyboard()
  .text(BTN_ORDERS)
  .row()
  .text(BTN_PRICES)
  .text(BTN_STATS)
  .row()
  .text(BTN_CLIENT)
  .resized()
  .persistent();

/**
 * Dispatcher bot (SPEC §7): /prices, /stats commands and handling of the buttons
 * under orders. Uses the shared DISPATCHER_BOT instance (the same one that sends
 * notifications from TelegramOrderDispatcher). Hits the DB only via module services (§6).
 */
@Injectable()
export class DispatcherBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherBotService.name);

  constructor(
    @Inject(DISPATCHER_BOT) private readonly bot: DispatcherBot | null,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
    private readonly pricingSettings: PricingSettingsService,
    private readonly clients: ClientsService,
  ) {}

  onModuleInit(): void {
    if (!this.bot) {
      this.logger.warn(
        'DISPATCHER_BOT_TOKEN is not set — dispatcher bot not started',
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

    // Telegram command menu ("/") — an independent API call, don't block startup.
    void bot.api
      .setMyCommands(dispatcherCommands)
      .catch((err: Error) =>
        this.logger.warn(`setMyCommands failed: ${err.message}`),
      );

    // start() resolves only on stop — do NOT await, or init would hang.
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

  /** Let through updates only from a configured dispatcher chat (if any are set). */
  private useChatGuard(bot: DispatcherBot): void {
    const allowed = dispatcherChatIds(this.config);
    if (!allowed.length) return;
    bot.use(async (ctx, next) => {
      if (ctx.chat && !allowed.includes(String(ctx.chat.id))) return;
      await next();
    });
  }

  private registerHandlers(bot: DispatcherBot): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('help', (ctx) => this.onHelp(ctx));
    bot.command('orders', (ctx) => this.onActiveOrders(ctx));
    bot.command('prices', (ctx) => this.onPrices(ctx));
    bot.command('stats', (ctx) => this.onStats(ctx));
    bot.command('client', (ctx) => this.onClientLookupStart(ctx));
    bot.callbackQuery(/^acc:(.+)$/, (ctx) => this.onTransition(ctx, 'accept'));
    bot.callbackQuery(/^del:(.+)$/, (ctx) => this.onTransition(ctx, 'deliver'));
    bot.callbackQuery(/^can:(.+)$/, (ctx) => this.onTransition(ctx, 'cancel'));
    bot.callbackQuery(/^edit:(.+)$/, (ctx) => this.onEditOrder(ctx));
    bot.callbackQuery(/^claim:(.+)$/, (ctx) => this.onEditClaim(ctx));
    bot.callbackQuery(/^geo:(.+)$/, (ctx) => this.onGeoTag(ctx));
    bot.callbackQuery(/^drvline:(.+)$/, (ctx) => this.onDriverLine(ctx));
    bot.callbackQuery('pe_cancel', (ctx) => this.onCancelPriceEdit(ctx));
    bot.callbackQuery(
      /^pe:(price1|priceFrom2|priceFrom6|depositPerBottle|pumpPrice|electroPumpPrice|waterStartPrice)$/,
      (ctx) => this.onPickPriceField(ctx),
    );
    // message:text — after commands, so /prices and /stats do not fall here.
    bot.on('message:text', (ctx) => this.onText(ctx));
    // Native Telegram location (mobile pin) — only acted on in geo-tagging mode.
    bot.on('message:location', (ctx) => this.onLocation(ctx));
  }

  /** Button under an order: change the status and redraw the message. */
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
      // Invalid transition (double tap, wrong status) — don't crash, report via toast.
      await ctx.answerCallbackQuery({
        text: 'Вже оброблено або недоступно',
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Готово' });
    await this.refreshOrderMessage(ctx, id);
  }

  /** Redraws the order message to reflect the current status and buttons. */
  private async refreshOrderMessage(
    ctx: DispatcherContext,
    id: string,
  ): Promise<void> {
    const view = await this.orders.getOrderView(id);
    if (!view) return;
    await ctx.editMessageText(orderMessage(view, view.client, view.address), {
      reply_markup: orderKeyboard(view.id, view.status, view.kind),
    });
  }

  /** /start — greeting + persistent reply menu (the dispatcher's entry point). */
  private async onStart(ctx: DispatcherContext): Promise<void> {
    await ctx.reply(dispatcherWelcome, {
      reply_markup: dispatcherMenuKeyboard,
    });
  }

  /** /help — short command reference. */
  private async onHelp(ctx: DispatcherContext): Promise<void> {
    await ctx.reply(dispatcherHelp);
  }

  /**
   * /orders (and the "📋 Активні" button) — the work queue: orders in statuses
   * created/accepted, each as a separate card with action buttons, so they can be
   * handled even if the original push scrolled up the chat.
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
        reply_markup: orderKeyboard(order.id, order.status, order.kind),
      });
    }
  }

  /** /prices — current prices + buttons to pick a field for editing. */
  private async onPrices(ctx: DispatcherContext): Promise<void> {
    // Reset any unfinished editing: re-entering /prices cancels the pending input
    // (otherwise the next number would go into the previous field/order).
    ctx.session.editingPriceField = undefined;
    ctx.session.editingOrderId = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.lookupClient = undefined;
    const prices = await this.pricingSettings.getCurrent();
    await ctx.reply(pricesMessage(prices), { reply_markup: pricesKeyboard() });
  }

  /** Price field picked: remember it in the session and wait for a number next message. */
  private async onPickPriceField(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const field = ctx.match?.[1] as EditablePriceField | undefined;
    if (!field) return;
    ctx.session.editingOrderId = undefined; // input modes are mutually exclusive
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.editingPriceField = field;
    await ctx.reply(
      `Введіть нове значення для «${priceFieldLabel(field)}» (ціле число грн):`,
      { reply_markup: priceEditCancelKeyboard() },
    );
  }

  /** "❌ Cancel" under the price prompt: reset editing. */
  private async onCancelPriceEdit(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (!ctx.session.editingPriceField) return; // already saved/irrelevant
    ctx.session.editingPriceField = undefined;
    // editMessageText without reply_markup also removes the "Cancel" button.
    await ctx.editMessageText('Зміну ціни скасовано.');
  }

  /** "✏️ Edit": remember the order and wait for the new bottle quantity as text. */
  private async onEditOrder(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.editingOrderId = id;
    await ctx.reply(editQuantityPrompt(id));
  }

  /**
   * "🔢 Звірити баки" on an OWN_TARA order: remember the order and wait for the
   * corrected declared balance as text (step B). Only this order's `claimedOnHand`
   * is changed — see {@link OrdersService.editClaimedOnHand}.
   */
  private async onEditClaim(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.editingClaimOrderId = id;
    await ctx.reply(editClaimPrompt(id));
  }

  /**
   * "📍 Прив’язати точку": remember the order and wait for the delivery coordinates,
   * either as a native Telegram location (handled in {@link onLocation}) or as pasted
   * coords / a maps link (handled as text via the `set-geo` intent).
   */
  private async onGeoTag(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrderId = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.geoTaggingOrderId = id;
    await ctx.reply(geoTagPrompt(id));
  }

  /**
   * "🔎 Клієнт" / /client: start a client lookup by phone. With an inline argument
   * (`/client 0501234567`) searches right away; otherwise waits for the phone as text.
   */
  private async onClientLookupStart(ctx: DispatcherContext): Promise<void> {
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrderId = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    const arg = ctx.match;
    const query = typeof arg === 'string' ? arg.trim() : '';
    if (query) {
      ctx.session.lookupClient = undefined;
      await this.applyClientLookup(ctx, query);
      return;
    }
    ctx.session.lookupClient = true;
    await ctx.reply(clientLookupPrompt);
  }

  /**
   * Looks clients up by a phone fragment and replies with a card per match (identity,
   * tara/pump, default address + map link, last order). Read-only.
   */
  private async applyClientLookup(
    ctx: DispatcherContext,
    rawPhone: string,
  ): Promise<void> {
    ctx.session.lookupClient = undefined;
    const token = phoneSearchToken(rawPhone);
    if (!token) {
      await ctx.reply('Замало цифр. Введіть більше цифр номера.');
      return;
    }
    const clients = await this.clients.searchByPhone(token);
    if (!clients.length) {
      await ctx.reply(noClientFound);
      return;
    }
    for (const client of clients) {
      const [address, recent] = await Promise.all([
        this.clients.getDefaultAddress(client.id),
        this.orders.listByClient(client.id, 1),
      ]);
      await ctx.reply(clientCardMessage(client, address, recent[0] ?? null), {
        link_preview_options: { is_disabled: true },
      });
    }
  }

  /**
   * "📋 Рядок водію": sends the forward-friendly hand-off block as a STANDALONE
   * message, so the dispatcher can forward it to the driver (a line embedded in the
   * card cannot be forwarded alone). Read-only — does not change the order.
   */
  private async onDriverLine(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const view = await this.orders.getOrderView(id);
    if (!view) {
      await ctx.answerCallbackQuery({ text: 'Замовлення недоступне' });
      return;
    }
    await ctx.answerCallbackQuery();
    const unit = await this.orders.waterUnitPrice(view.bottles);
    // No link preview — keep the forwarded block compact.
    await ctx.reply(driverLine(view, view.client, view.address, unit), {
      link_preview_options: { is_disabled: true },
    });
  }

  /**
   * Native Telegram location (mobile pin). Acted on ONLY while geo-tagging an order —
   * a stray location otherwise is ignored, so it cannot overwrite a random address.
   */
  private async onLocation(ctx: DispatcherContext): Promise<void> {
    const orderId = ctx.session.geoTaggingOrderId;
    const location = ctx.message?.location;
    if (!orderId || !location) return;
    await this.applySetGeo(ctx, orderId, location.latitude, location.longitude);
  }

  /**
   * Text: first the persistent menu buttons (priority, so "💰 Ціни" is not taken
   * as a price value), then — number input on the editing step.
   */
  private async onText(ctx: DispatcherContext): Promise<void> {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    const intent = routeDispatcherText(text, ctx.session);
    switch (intent.kind) {
      case 'menu':
        if (intent.action === 'orders') await this.onActiveOrders(ctx);
        else if (intent.action === 'prices') await this.onPrices(ctx);
        else if (intent.action === 'client')
          await this.onClientLookupStart(ctx);
        else await this.onStats(ctx);
        return;
      case 'lookup-client':
        // Phone typed after "🔎 Клієнт" — search and show client card(s).
        await this.applyClientLookup(ctx, text);
        return;
      case 'edit-quantity':
        // New quantity input for an order (✏️ Edit) — priority over price.
        await this.applyEditedQuantity(ctx, intent.orderId, text);
        return;
      case 'edit-claim':
        // Corrected declared balance for an OWN_TARA order (🔢 step B).
        await this.applyEditedClaim(ctx, intent.orderId, text);
        return;
      case 'set-geo': {
        // Pasted coordinates / maps link for an order's address (📍 geo-tagging).
        const coords = parseGeoInput(text);
        if (!coords) {
          await ctx.reply(
            'Не розпізнав координати. Надішліть локацію або «49.42, 26.99» / посилання на карту.',
          );
          return;
        }
        await this.applySetGeo(ctx, intent.orderId, coords.lat, coords.lng);
        return;
      }
      case 'edit-price': {
        const parsed = parsePriceValue(text);
        if (!parsed.ok) {
          await ctx.reply('Потрібне ціле невід’ємне число. Спробуйте ще раз.');
          return;
        }
        const updated = await this.pricingSettings.update(
          intent.field,
          parsed.value,
        );
        ctx.session.editingPriceField = undefined;
        await ctx.reply(`Збережено ✅\n\n${pricesMessage(updated)}`, {
          reply_markup: pricesKeyboard(),
        });
        return;
      }
      case 'ignore':
        return;
    }
  }

  /** Parses the quantity and applies the order edit; on error — wait again. */
  private async applyEditedQuantity(
    ctx: DispatcherContext,
    orderId: string,
    text: string,
  ): Promise<void> {
    const parsed = parseEditedQuantity(text, MAX_EDIT_QTY);
    if (!parsed.ok) {
      await ctx.reply(
        `Потрібне ціле число від 1 до ${MAX_EDIT_QTY}. Спробуйте ще раз.`,
      );
      return;
    }
    let view: OrderWithRelations;
    try {
      view = await this.orders.editQuantity(orderId, parsed.value);
    } catch {
      // Order already delivered/cancelled/deleted — editing unavailable.
      ctx.session.editingOrderId = undefined;
      await ctx.reply('Це замовлення вже не можна змінити.');
      return;
    }
    ctx.session.editingOrderId = undefined;
    await ctx.reply(
      `Змінено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status, view.kind) },
    );
  }

  /**
   * Parses the corrected declared balance and applies it to an OWN_TARA order (step B);
   * on a parse error — wait for another number. Bounds match the client-side tara cap.
   */
  private async applyEditedClaim(
    ctx: DispatcherContext,
    orderId: string,
    text: string,
  ): Promise<void> {
    const parsed = parseEditedQuantity(text, MAX_EDIT_QTY);
    if (!parsed.ok) {
      await ctx.reply(
        `Потрібне ціле число від 1 до ${MAX_EDIT_QTY}. Спробуйте ще раз.`,
      );
      return;
    }
    let view: OrderWithRelations;
    try {
      view = await this.orders.editClaimedOnHand(orderId, parsed.value);
    } catch {
      // No longer CREATED / not an OWN_TARA claim / deleted — correction unavailable.
      ctx.session.editingClaimOrderId = undefined;
      await ctx.reply('Цей баланс уже не можна змінити.');
      return;
    }
    ctx.session.editingClaimOrderId = undefined;
    await ctx.reply(
      `Звірено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status, view.kind) },
    );
  }

  /**
   * Saves delivery coordinates to the order's address and redraws the card (with the
   * map link). Shared by the native-location and pasted-text paths.
   */
  private async applySetGeo(
    ctx: DispatcherContext,
    orderId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
    let view: OrderWithRelations;
    try {
      view = await this.orders.setOrderAddressGeo(orderId, lat, lng);
    } catch {
      // Order deleted / no longer available.
      ctx.session.geoTaggingOrderId = undefined;
      await ctx.reply('Не вдалося прив’язати точку до цього замовлення.');
      return;
    }
    ctx.session.geoTaggingOrderId = undefined;
    await ctx.reply(
      `Точку збережено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status, view.kind) },
    );
  }

  /** /stats — summary for today and this week (SPEC §7). */
  private async onStats(ctx: DispatcherContext): Promise<void> {
    const stats = await this.orders.stats();
    await ctx.reply(statsMessage(stats));
  }
}
