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
import { ContactsService } from '../../modules/contacts/contacts.service';
import { DispatchersService } from '../../modules/dispatchers/dispatchers.service';
import {
  DISPATCHER_BOT,
  superAdminChatId,
  type DispatcherBot,
  type DispatcherContext,
  type DispatcherSession,
} from './dispatcher-bot.bot';
import {
  activeOrdersCappedNote,
  activeOrdersSummary,
  addContactPrompt,
  addDispatcherPrompt,
  contactAddInvalid,
  contactsKeyboard,
  contactsListMessage,
  dispatcherAddInvalid,
  dispatcherCommands,
  dispatcherFetchFailedNote,
  dispatcherHelp,
  dispatchersForbidden,
  dispatchersKeyboard,
  dispatchersListMessage,
  cancelReasonCustomPrompt,
  cancelReasonPreset,
  clientCardMessage,
  clientLookupPrompt,
  confirmCancelKeyboard,
  confirmCancelPrompt,
  confirmDeliverKeyboard,
  confirmDeliverPrompt,
  deliveryEtaAcceptNudge,
  deliveryEtaCustomPrompt,
  deliveryEtaKeyboard,
  deliveryEtaPreset,
  deliveryEtaPrompt,
  deliveryEtaSent,
  dispatcherWelcome,
  driverLine,
  editAddressPrompt,
  editClaimPrompt,
  editCommentPrompt,
  editMenuKeyboard,
  editMenuPrompt,
  editQuantityPrompt,
  geoTagPrompt,
  noActiveOrders,
  noClientFound,
  orderKeyboard,
  orderLookupPrompt,
  orderMessage,
  orderNotFound,
  priceEditCancelKeyboard,
  priceFieldLabel,
  pricesKeyboard,
  pricesMessage,
  statsMessage,
  undoCancelKeyboard,
  undoCancelText,
} from './dispatcher-bot.texts';
import {
  ACTIVE_CARDS_CAP,
  BTN_CLIENT,
  BTN_CONTACTS,
  BTN_ORDERS,
  BTN_PRICES,
  BTN_STATS,
  type OrderEditField,
  formatChatTitle,
  normalizeOrderIdArg,
  parseDispatcherInput,
  parseEditedQuantity,
  parseGeoInput,
  parsePriceValue,
  phoneSearchToken,
  routeDispatcherText,
  sortActiveQueue,
  summarizeQueue,
  terminalActionOf,
} from './dispatcher-bot.fsm';
import { OrderStatus } from '../../../generated/prisma/enums';

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
  .text(BTN_CONTACTS)
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
    private readonly contacts: ContactsService,
    private readonly clients: ClientsService,
    private readonly dispatchers: DispatchersService,
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

  /**
   * Let through updates only from an allowed dispatcher chat: the env super-admin ∪
   * active DB dispatchers. Queried per update (the table is tiny) so a just-added
   * dispatcher is admitted immediately. With nothing configured (no admin, empty DB)
   * the guard admits all — a partial local run stays possible.
   */
  private useChatGuard(bot: DispatcherBot): void {
    const adminChatId = superAdminChatId(this.config);
    bot.use(async (ctx, next) => {
      const allowed = await this.dispatchers.allowedChatIds(adminChatId);
      if (allowed.length && ctx.chat && !allowed.includes(String(ctx.chat.id)))
        return;
      await next();
    });
  }

  /** True only for the env super-admin chat — the sole manager of the dispatcher list. */
  private isSuperAdmin(ctx: DispatcherContext): boolean {
    const admin = superAdminChatId(this.config);
    return !!admin && !!ctx.chat && String(ctx.chat.id) === admin;
  }

  private registerHandlers(bot: DispatcherBot): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('help', (ctx) => this.onHelp(ctx));
    bot.command('orders', (ctx) => this.onActiveOrders(ctx));
    bot.command('order', (ctx) => this.onOrderLookupStart(ctx));
    bot.command('prices', (ctx) => this.onPrices(ctx));
    bot.command('stats', (ctx) => this.onStats(ctx));
    bot.command('client', (ctx) => this.onClientLookupStart(ctx));
    bot.command('contacts', (ctx) => this.onContacts(ctx));
    bot.command('dispatchers', (ctx) => this.onDispatchers(ctx));
    bot.callbackQuery(/^acc:(.+)$/, (ctx) => this.onTransition(ctx, 'accept'));
    // Terminal actions are two-step (mis-tap protection): the card button opens an
    // are-you-sure confirm; only its "Так" runs the real transition.
    bot.callbackQuery(/^del:(.+)$/, (ctx) => this.onConfirmRequest(ctx, 'del'));
    bot.callbackQuery(/^can:(.+)$/, (ctx) => this.onConfirmRequest(ctx, 'can'));
    // Cancel confirm doubles as a reason picker: a preset both confirms and records
    // why; "✏️ Інша причина" switches to free text; "Ні, залишити" (cann) dismisses.
    bot.callbackQuery(/^canr:(zone|mind|dup|noans):(.+)$/, (ctx) =>
      this.onCancelWithReason(ctx),
    );
    bot.callbackQuery(/^canx:(.+)$/, (ctx) => this.onCancelReasonCustom(ctx));
    bot.callbackQuery(/^delc:(.+)$/, (ctx) => this.onConfirmDeliver(ctx));
    bot.callbackQuery(/^cann:(.+)$/, (ctx) => this.onDismissConfirm(ctx));
    bot.callbackQuery(/^deln:(.+)$/, (ctx) => this.onDismissConfirm(ctx));
    bot.callbackQuery(/^unc:(.+)$/, (ctx) => this.onUndoCancel(ctx));
    bot.callbackQuery(/^edit:(.+)$/, (ctx) => this.onEditOrder(ctx));
    bot.callbackQuery(/^ef:(qty|addr|comment):(.+)$/, (ctx) =>
      this.onPickEditField(ctx),
    );
    bot.callbackQuery('ef_cancel', (ctx) => this.onCancelOrderEdit(ctx));
    bot.callbackQuery(/^claim:(.+)$/, (ctx) => this.onEditClaim(ctx));
    bot.callbackQuery(/^geo:(.+)$/, (ctx) => this.onGeoTag(ctx));
    bot.callbackQuery(/^eta:(.+)$/, (ctx) => this.onDeliveryEtaStart(ctx));
    bot.callbackQuery(/^etap:(td|tm|h1|h2):(.+)$/, (ctx) =>
      this.onPickDeliveryPreset(ctx),
    );
    bot.callbackQuery(/^etac:(.+)$/, (ctx) => this.onDeliveryEtaCustom(ctx));
    bot.callbackQuery(/^etax:(.+)$/, (ctx) => this.onDeliveryEtaCancel(ctx));
    bot.callbackQuery(/^drvline:(.+)$/, (ctx) => this.onDriverLine(ctx));
    bot.callbackQuery('ct:add', (ctx) => this.onAddContactStart(ctx));
    bot.callbackQuery(/^ct:tgl:(.+)$/, (ctx) => this.onToggleContact(ctx));
    bot.callbackQuery(/^ct:del:(.+)$/, (ctx) => this.onDeleteContact(ctx));
    bot.callbackQuery('dp:add', (ctx) => this.onAddDispatcherStart(ctx));
    bot.callbackQuery(/^dp:tgl:(.+)$/, (ctx) => this.onToggleDispatcher(ctx));
    bot.callbackQuery(/^dp:del:(.+)$/, (ctx) => this.onDeleteDispatcher(ctx));
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
    // Right after accepting, nudge the dispatcher to tell the client the timing
    // (variant B). A separate message so the freshly-redrawn card keeps its buttons;
    // ignoring it is fine — the time can also be set later via "🕒 Час доставки".
    if (action === 'accept') {
      await ctx.reply(deliveryEtaAcceptNudge(id), {
        reply_markup: deliveryEtaKeyboard(id),
      });
    }
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

  /**
   * A terminal card button (❌ Скасувати / 🚚 Доставлено) was tapped: do NOT act yet —
   * mis-tap protection. Replace the card in place with an are-you-sure confirm (no
   * dangling keyboard, mirrors onEditOrder/onPickEditField). Only its "Так" runs the
   * real transition; "Ні" redraws the normal card. `prefix` is untrusted callback data.
   */
  private async onConfirmRequest(
    ctx: DispatcherContext,
    prefix: string,
  ): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    const action = terminalActionOf(prefix);
    if (!id || !action) return;
    const prompt =
      action === 'cancel' ? confirmCancelPrompt(id) : confirmDeliverPrompt(id);
    const keyboard =
      action === 'cancel'
        ? confirmCancelKeyboard(id)
        : confirmDeliverKeyboard(id);
    // editMessageText replaces the card with the confirm and drops the card's keyboard.
    await ctx.editMessageText(prompt, { reply_markup: keyboard });
  }

  /**
   * "Так, доставлено" on the delivery confirm: run the guarded transition and redraw the
   * card to its (button-less) terminal state. No undo (tara is credited) — that is why
   * delivery asks first. An invalid transition (already handled / raced) → a toast.
   */
  private async onConfirmDeliver(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.orders.markDelivered(id);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Вже оброблено або недоступно' });
      await this.refreshOrderMessage(ctx, id);
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Готово' });
    await this.refreshOrderMessage(ctx, id);
  }

  /**
   * A cancellation reason preset was picked (❌ → «Поза зоною» …): it both confirms the
   * cancel and records why. Cancels with the reason, redraws the card (now showing the
   * reason) and offers the one-tap undo. Unknown key / raced transition → a toast, no crash.
   */
  private async onCancelWithReason(ctx: DispatcherContext): Promise<void> {
    const key = ctx.match?.[1];
    const id = ctx.match?.[2];
    const reason = key ? cancelReasonPreset(key) : undefined;
    if (!id || !reason) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.orders.cancelOrder(id, reason);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Вже оброблено або недоступно' });
      await this.refreshOrderMessage(ctx, id);
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Готово' });
    await this.refreshOrderMessage(ctx, id);
    await ctx.reply(undoCancelText(id), {
      reply_markup: undoCancelKeyboard(id),
    });
  }

  /**
   * "✏️ Інша причина" in the cancel picker: wait for a free-text reason. Replaces the
   * picker with the prompt (no dangling keyboard); the typed reason is handled as the
   * `cancel-reason` intent in {@link onText}.
   */
  private async onCancelReasonCustom(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    ctx.session.cancellingOrderId = id;
    await ctx.editMessageText(cancelReasonCustomPrompt(id));
  }

  /**
   * Free-text cancellation reason typed (❌ → ✏️ Інша причина): cancel with it, then send
   * the cancelled card (a new message — the trigger was text, not an inline card) and the
   * undo affordance. An inactive order → a graceful message; the mode is cleared either way.
   */
  private async applyCancelReason(
    ctx: DispatcherContext,
    orderId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.orders.cancelOrder(orderId, text);
    } catch {
      ctx.session.cancellingOrderId = undefined;
      await ctx.reply('Це замовлення вже не можна скасувати.');
      return;
    }
    ctx.session.cancellingOrderId = undefined;
    const view = await this.orders.getOrderView(orderId);
    if (view) {
      await ctx.reply(orderMessage(view, view.client, view.address), {
        reply_markup: orderKeyboard(view.id, view.status, view.kind),
      });
    }
    await ctx.reply(undoCancelText(orderId), {
      reply_markup: undoCancelKeyboard(orderId),
    });
  }

  /** "Ні" on a terminal confirm: keep the order — restore the normal card in place. */
  private async onDismissConfirm(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    await this.refreshOrderMessage(ctx, id);
  }

  /**
   * "↩️ Повернути": undo a just-made cancel (CANCELLED → CREATED via the guarded
   * service method) and drop the undo message, replacing it with the revived card
   * (buttons restored). A no-longer-cancelled order → a toast, no crash.
   */
  private async onUndoCancel(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.orders.revertCancellation(id);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Уже не можна повернути' });
      // Drop the now-useless undo button so it can't be tapped again.
      await ctx.editMessageText('Уже не можна повернути.');
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Повернено' });
    const view = await this.orders.getOrderView(id);
    if (!view) {
      await ctx.editMessageText('Замовлення повернено в роботу ✅');
      return;
    }
    // Replace the undo message with the revived card (buttons restored) — no dead end.
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
   * /orders (and the "📋 Активні" button) — the work queue as a readable overview, not a
   * flood: a summary header (totals by status + age of the oldest unhandled order) with a
   * one-liner per active order, then the full actionable cards oldest-first, unhandled
   * (CREATED) first. When the queue is large (> ACTIVE_CARDS_CAP) only the unhandled
   * orders get full cards — the rest stay in the summary above (with a note), so the chat
   * is not flooded. All ordering/age math is pure (dispatcher-bot.fsm), `now` passed in.
   */
  private async onActiveOrders(ctx: DispatcherContext): Promise<void> {
    const orders = await this.orders.listActive();
    if (!orders.length) {
      await ctx.reply(noActiveOrders);
      return;
    }
    const now = new Date();
    const sorted = sortActiveQueue(orders);
    const summary = summarizeQueue(sorted);
    await ctx.reply(activeOrdersSummary(sorted, summary, now));

    // Over the cap: full cards only for the unhandled (CREATED) orders; the accepted
    // ones remain in the summary above (referenced by the note) to avoid the flood.
    const capped = sorted.length > ACTIVE_CARDS_CAP;
    const cards = capped
      ? sorted.filter((o) => o.status === OrderStatus.CREATED)
      : sorted;
    for (const order of cards) {
      await ctx.reply(orderMessage(order, order.client, order.address), {
        reply_markup: orderKeyboard(order.id, order.status, order.kind),
      });
    }
    if (capped && summary.accepted > 0) {
      await ctx.reply(activeOrdersCappedNote(summary.accepted));
    }
  }

  /** /prices — current prices + buttons to pick a field for editing. */
  private async onPrices(ctx: DispatcherContext): Promise<void> {
    // Reset any unfinished editing: re-entering /prices cancels the pending input
    // (otherwise the next number would go into the previous field/order).
    ctx.session.editingPriceField = undefined;
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const prices = await this.pricingSettings.getCurrent();
    await ctx.reply(pricesMessage(prices), { reply_markup: pricesKeyboard() });
  }

  /** Price field picked: remember it in the session and wait for a number next message. */
  private async onPickPriceField(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const field = ctx.match?.[1] as EditablePriceField | undefined;
    if (!field) return;
    ctx.session.editingOrder = undefined; // input modes are mutually exclusive
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
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

  /** "✏️ Змінити": open the sub-menu to pick WHICH field of the order to edit. */
  private async onEditOrder(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    await ctx.reply(editMenuPrompt(id), {
      reply_markup: editMenuKeyboard(id),
    });
  }

  /**
   * Field picked in the edit sub-menu: remember the order + field and wait for the
   * new value as text. Replaces the menu with the field prompt (no dangling buttons).
   */
  private async onPickEditField(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const field = ctx.match?.[1] as OrderEditField | undefined;
    const id = ctx.match?.[2];
    if (!field || !id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    ctx.session.editingOrder = { id, field };
    const prompt =
      field === 'qty'
        ? editQuantityPrompt(id)
        : field === 'addr'
          ? editAddressPrompt(id)
          : editCommentPrompt(id);
    // editMessageText replaces the menu and drops its inline keyboard.
    await ctx.editMessageText(prompt);
  }

  /** "❌ Скасувати" in the edit sub-menu: drop the menu and reset editing. */
  private async onCancelOrderEdit(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    ctx.session.editingOrder = undefined;
    await ctx.editMessageText('Редагування скасовано.');
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
    ctx.session.editingOrder = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
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
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    ctx.session.geoTaggingOrderId = id;
    await ctx.reply(geoTagPrompt(id));
  }

  /**
   * "🕒 Час доставки": open the delivery-timing picker for the client. Sent as a NEW
   * message (the card keeps its buttons); presets set the note directly, "✏️ Свій
   * варіант" switches to text input. Also used as the accept nudge (variant B).
   */
  private async onDeliveryEtaStart(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    await ctx.reply(deliveryEtaPrompt(id), {
      reply_markup: deliveryEtaKeyboard(id),
    });
  }

  /**
   * A delivery-timing preset was picked: store it on the order (which pushes the
   * client via the delivery-note event) and turn this picker message into a
   * confirmation. Unknown key / inactive order → a graceful message, no crash.
   */
  private async onPickDeliveryPreset(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const key = ctx.match?.[1];
    const id = ctx.match?.[2];
    if (!key || !id) return;
    const note = deliveryEtaPreset(key);
    if (!note) return;
    try {
      await this.orders.setDeliveryNote(id, note);
    } catch {
      await ctx.editMessageText(
        'Це замовлення вже не активне — час не надіслано.',
      );
      return;
    }
    await ctx.editMessageText(deliveryEtaSent(id, note));
  }

  /** "✏️ Свій варіант" in the picker: wait for a custom timing message as text. */
  private async onDeliveryEtaCustom(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const id = ctx.match?.[1];
    if (!id) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    ctx.session.deliveryNoteOrderId = id;
    await ctx.editMessageText(deliveryEtaCustomPrompt(id));
  }

  /** "❌ Скасувати" in the picker: drop it without sending anything. */
  private async onDeliveryEtaCancel(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    ctx.session.deliveryNoteOrderId = undefined;
    await ctx.editMessageText('Скасовано.');
  }

  /**
   * "🔎 Клієнт" / /client: start a client lookup by phone. With an inline argument
   * (`/client 0501234567`) searches right away; otherwise waits for the phone as text.
   */
  private async onClientLookupStart(ctx: DispatcherContext): Promise<void> {
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const arg = ctx.match;
    const query = typeof arg === 'string' ? arg.trim() : '';
    if (query) {
      ctx.session.lookupClient = undefined;
      ctx.session.lookupOrder = undefined;
      ctx.session.cancellingOrderId = undefined;
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
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
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
   * /order: read-only lookup of an order by its short id (`#a1b2c3d4`, with/without `#`)
   * or a full uuid. After an order leaves the active list it can't be re-opened by button,
   * only pulled up here. With an inline argument (`/order a1b2c3d4`) searches right away;
   * otherwise waits for the id as text. Mirrors {@link onClientLookupStart}.
   */
  private async onOrderLookupStart(ctx: DispatcherContext): Promise<void> {
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const arg = ctx.match;
    const query = typeof arg === 'string' ? arg.trim() : '';
    if (query) {
      ctx.session.lookupOrder = undefined;
      ctx.session.cancellingOrderId = undefined;
      await this.applyOrderLookup(ctx, query);
      return;
    }
    ctx.session.lookupOrder = true;
    await ctx.reply(orderLookupPrompt);
  }

  /**
   * Looks an order up by its (short or full) id and replies with the full card per match.
   * A still-active order keeps its action buttons (orderKeyboard); a terminal one has none
   * (orderKeyboard returns undefined). Read-only. Garbage / unknown id → a friendly message.
   */
  private async applyOrderLookup(
    ctx: DispatcherContext,
    rawId: string,
  ): Promise<void> {
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    const prefix = normalizeOrderIdArg(rawId);
    if (!prefix) {
      await ctx.reply(orderNotFound);
      return;
    }
    const orders = await this.orders.findByShortIdPrefix(prefix);
    if (!orders.length) {
      await ctx.reply(orderNotFound);
      return;
    }
    for (const order of orders) {
      await ctx.reply(orderMessage(order, order.client, order.address), {
        reply_markup: orderKeyboard(order.id, order.status, order.kind),
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
        else if (intent.action === 'contacts') await this.onContacts(ctx);
        else await this.onStats(ctx);
        return;
      case 'lookup-client':
        // Phone typed after "🔎 Клієнт" — search and show client card(s).
        await this.applyClientLookup(ctx, text);
        return;
      case 'lookup-order':
        // Order id typed after /order — search and show the order card(s).
        await this.applyOrderLookup(ctx, text);
        return;
      case 'add-contact':
        // New support phone typed after "📞 Контакти → ➕".
        await this.applyAddContact(ctx, text);
        return;
      case 'add-dispatcher':
        // chat_id (+ optional label) typed after "/dispatchers → ➕" (super-admin only).
        await this.applyAddDispatcher(ctx, text);
        return;
      case 'edit-order':
        // New value for the picked field of an order (✏️ Edit) — priority over price.
        await this.applyOrderEdit(ctx, intent.orderId, intent.field, text);
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
      case 'set-delivery-note':
        // Custom delivery-timing message typed after "🕒 ✏️ Свій варіант".
        await this.applyDeliveryNote(ctx, intent.orderId, text);
        return;
      case 'cancel-reason':
        // Free-text cancellation reason typed after "❌ → ✏️ Інша причина".
        await this.applyCancelReason(ctx, intent.orderId, text);
        return;
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

  /**
   * Applies an order edit by the picked field. Quantity has its own parse/bounds path;
   * address and comment take the trimmed text as-is (non-empty by onText's guard). The
   * client is notified from the service via the order-edited event.
   */
  private async applyOrderEdit(
    ctx: DispatcherContext,
    orderId: string,
    field: OrderEditField,
    text: string,
  ): Promise<void> {
    if (field === 'qty') {
      await this.applyEditedQuantity(ctx, orderId, text);
      return;
    }
    let view: OrderWithRelations;
    try {
      view =
        field === 'addr'
          ? await this.orders.editOrderAddress(orderId, text)
          : await this.orders.editOrderComment(orderId, text);
    } catch {
      // Order already delivered/cancelled/deleted — editing unavailable.
      ctx.session.editingOrder = undefined;
      await ctx.reply('Це замовлення вже не можна змінити.');
      return;
    }
    ctx.session.editingOrder = undefined;
    await ctx.reply(
      `Змінено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status, view.kind) },
    );
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
      ctx.session.editingOrder = undefined;
      await ctx.reply('Це замовлення вже не можна змінити.');
      return;
    }
    ctx.session.editingOrder = undefined;
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
      ctx.session.deliveryNoteOrderId = undefined;
      await ctx.reply('Не вдалося прив’язати точку до цього замовлення.');
      return;
    }
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    await ctx.reply(
      `Точку збережено ✅\n\n${orderMessage(view, view.client, view.address)}`,
      { reply_markup: orderKeyboard(view.id, view.status, view.kind) },
    );
  }

  /**
   * Stores a custom delivery-timing message on the order (which pushes the client via
   * the delivery-note event) and confirms to the dispatcher. On an inactive order —
   * a graceful message; the input mode is cleared either way.
   */
  private async applyDeliveryNote(
    ctx: DispatcherContext,
    orderId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.orders.setDeliveryNote(orderId, text);
    } catch {
      ctx.session.deliveryNoteOrderId = undefined;
      await ctx.reply('Це замовлення вже не активне — час не надіслано.');
      return;
    }
    ctx.session.deliveryNoteOrderId = undefined;
    await ctx.reply(deliveryEtaSent(orderId, text));
  }

  /**
   * /contacts (and the "📞 Контакти" button) — manage the support phones the client
   * sees on "Зв'язатися". Cancels any pending input (like /prices) and shows the list.
   */
  private async onContacts(ctx: DispatcherContext): Promise<void> {
    ctx.session.editingPriceField = undefined;
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const contacts = await this.contacts.listAll();
    await ctx.reply(contactsListMessage(contacts), {
      reply_markup: contactsKeyboard(contacts),
    });
  }

  /** "➕ Додати номер": wait for the new phone as text (replaces the list buttons). */
  private async onAddContactStart(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingDispatcher = undefined;
    ctx.session.addingContact = true;
    await ctx.editMessageText(addContactPrompt);
  }

  /**
   * New support phone typed (📞 → ➕): normalize + save, then show the refreshed list.
   * An unrecognised number keeps the input mode and asks again (no dead end).
   */
  private async applyAddContact(
    ctx: DispatcherContext,
    text: string,
  ): Promise<void> {
    try {
      await this.contacts.add(text);
    } catch {
      // normalizeContactPhone rejected it — stay in adding mode and ask again.
      await ctx.reply(contactAddInvalid);
      return;
    }
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const contacts = await this.contacts.listAll();
    await ctx.reply(`Додано ✅\n\n${contactsListMessage(contacts)}`, {
      reply_markup: contactsKeyboard(contacts),
    });
  }

  /** "🙈/✅" on a number: toggle whether the client sees it; redraw the list in place. */
  private async onToggleContact(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const contacts = await this.contacts.listAll();
    const target = contacts.find((c) => c.id === id);
    if (!target) {
      await ctx.answerCallbackQuery({ text: 'Номер не знайдено' });
      await this.redrawContacts(ctx, contacts);
      return;
    }
    await this.contacts.setActive(id, !target.active);
    await ctx.answerCallbackQuery({
      text: target.active ? 'Приховано' : 'Показано',
    });
    await this.redrawContacts(ctx, await this.contacts.listAll());
  }

  /** "🗑" on a number: delete it; redraw the list in place. */
  private async onDeleteContact(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.contacts.remove(id);
    } catch {
      // Already gone — fall through to a redraw with the current list.
    }
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    await this.redrawContacts(ctx, await this.contacts.listAll());
  }

  /** Redraws the contacts message in place (edit), swallowing a too-old-to-edit error. */
  private async redrawContacts(
    ctx: DispatcherContext,
    contacts: Awaited<ReturnType<ContactsService['listAll']>>,
  ): Promise<void> {
    try {
      await ctx.editMessageText(contactsListMessage(contacts), {
        reply_markup: contactsKeyboard(contacts),
      });
    } catch {
      // Message too old / unchanged — the toast already reflected the action.
    }
  }

  /**
   * /dispatchers — manage the extra dispatcher chats (the env super-admin is always in,
   * unlisted and unremovable). Super-admin only: a regular dispatcher gets a refusal, so
   * the list of who has access can't be changed by anyone but the owner. Cancels any
   * pending input (like /prices) and shows the list.
   */
  private async onDispatchers(ctx: DispatcherContext): Promise<void> {
    if (!this.isSuperAdmin(ctx)) {
      await ctx.reply(dispatchersForbidden);
      return;
    }
    ctx.session.editingPriceField = undefined;
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = undefined;
    const dispatchers = await this.dispatchers.listAll();
    await ctx.reply(dispatchersListMessage(dispatchers), {
      reply_markup: dispatchersKeyboard(dispatchers),
    });
  }

  /** "➕ Додати диспетчера": wait for a chat id (+ optional label) as text. */
  private async onAddDispatcherStart(ctx: DispatcherContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (!this.isSuperAdmin(ctx)) return;
    ctx.session.editingPriceField = undefined; // input modes are mutually exclusive
    ctx.session.editingOrder = undefined;
    ctx.session.editingClaimOrderId = undefined;
    ctx.session.geoTaggingOrderId = undefined;
    ctx.session.deliveryNoteOrderId = undefined;
    ctx.session.lookupClient = undefined;
    ctx.session.lookupOrder = undefined;
    ctx.session.cancellingOrderId = undefined;
    ctx.session.addingContact = undefined;
    ctx.session.addingDispatcher = true;
    await ctx.editMessageText(addDispatcherPrompt);
  }

  /**
   * chat_id (+ optional label) typed (/dispatchers → ➕): parse, pull the person's name
   * via getChat (so the super-admin only needs the id), save, then show the refreshed
   * list. A typed label overrides the fetched name. A failed fetch usually means the
   * person hasn't started the bot (so orders won't reach them) — flagged, not hidden.
   * An unparseable id keeps the input mode and asks again. Guarded by super-admin again.
   */
  private async applyAddDispatcher(
    ctx: DispatcherContext,
    text: string,
  ): Promise<void> {
    if (!this.isSuperAdmin(ctx)) {
      ctx.session.addingDispatcher = undefined;
      return;
    }
    const parsed = parseDispatcherInput(text);
    if (!parsed) {
      // stay in adding mode and ask again.
      await ctx.reply(dispatcherAddInvalid);
      return;
    }
    let fetched: string | null = null;
    let fetchFailed = false;
    if (this.bot) {
      try {
        fetched = formatChatTitle(await this.bot.api.getChat(parsed.chatId));
      } catch {
        // Unknown chat — most likely the person never started the bot (see note below).
        fetchFailed = true;
      }
    }
    await this.dispatchers.add(parsed.chatId, parsed.label ?? fetched);
    ctx.session.addingDispatcher = undefined;
    const dispatchers = await this.dispatchers.listAll();
    const note = fetchFailed ? `\n\n${dispatcherFetchFailedNote}` : '';
    await ctx.reply(
      `Додано ✅${note}\n\n${dispatchersListMessage(dispatchers)}`,
      { reply_markup: dispatchersKeyboard(dispatchers) },
    );
  }

  /** "🙈/✅" on a dispatcher: toggle whether they get orders; redraw the list in place. */
  private async onToggleDispatcher(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id || !this.isSuperAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const dispatchers = await this.dispatchers.listAll();
    const target = dispatchers.find((d) => d.id === id);
    if (!target) {
      await ctx.answerCallbackQuery({ text: 'Диспетчера не знайдено' });
      await this.redrawDispatchers(ctx, dispatchers);
      return;
    }
    await this.dispatchers.setActive(id, !target.active);
    await ctx.answerCallbackQuery({
      text: target.active ? 'Вимкнено' : 'Увімкнено',
    });
    await this.redrawDispatchers(ctx, await this.dispatchers.listAll());
  }

  /** "🗑" on a dispatcher: delete it; redraw the list in place. */
  private async onDeleteDispatcher(ctx: DispatcherContext): Promise<void> {
    const id = ctx.match?.[1];
    if (!id || !this.isSuperAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await this.dispatchers.remove(id);
    } catch {
      // Already gone — fall through to a redraw with the current list.
    }
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    await this.redrawDispatchers(ctx, await this.dispatchers.listAll());
  }

  /** Redraws the dispatchers message in place (edit), swallowing a too-old-to-edit error. */
  private async redrawDispatchers(
    ctx: DispatcherContext,
    dispatchers: Awaited<ReturnType<DispatchersService['listAll']>>,
  ): Promise<void> {
    try {
      await ctx.editMessageText(dispatchersListMessage(dispatchers), {
        reply_markup: dispatchersKeyboard(dispatchers),
      });
    } catch {
      // Message too old / unchanged — the toast already reflected the action.
    }
  }

  /** /stats — summary for today and this week (SPEC §7). */
  private async onStats(ctx: DispatcherContext): Promise<void> {
    const stats = await this.orders.stats();
    await ctx.reply(statsMessage(stats));
  }
}
