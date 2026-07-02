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
  ORDER_EDITED,
  ORDER_DELIVERY_NOTE,
  type OrderStatusChangedEvent,
  type OrderEditedEvent,
  type OrderDeliveryNoteEvent,
} from '../../modules/orders/order-events';
import type { Address, Client, Order } from '../../../generated/prisma/client';
import { OrderStatus } from '../../../generated/prisma/enums';
import { texts } from './client-bot.texts';
import {
  assertNever,
  parseEditField,
  parseOnboardingChoice,
  parsePumpChoice,
  parseQty,
  parseTaraCount,
  parseTaraChoice,
  parseYesNo,
  resolveAfterQty,
  resolveBack,
  resolveConfirm,
  resolveFinalizeAddress,
  resolveStartOrder,
  Step,
  type ScreenIntent,
} from './client-bot.fsm';

/** Steps of the active order scenario — "Back"/"Cancel" act on them (SPEC §6). */
const ORDER_FLOW_STEPS: readonly Step[] = [
  Step.Onboarding,
  Step.PumpChoice,
  Step.OwnTaraCount,
  Step.OwnPumpAsk,
  Step.AwaitAddress,
  Step.AwaitComment,
  Step.ChooseQty,
  Step.Confirm,
  Step.EditMenu,
  Step.AwaitOrderNote,
];

interface SessionData {
  step: Step;
  /** Chosen number of bottles, carried from CHOOSE_QTY to CONFIRM. */
  bottles?: number;
  /**
   * Address (raw) entered at AWAIT_ADDRESS, before the comment is collected at
   * AWAIT_COMMENT. The Address is created as a single record only after the comment step.
   */
  addressRaw?: string;
  /**
   * Stack of previous order-scenario steps for the "Back" button (SPEC §6).
   * Only inline transitions inside the flow are pushed; reply buttons reset the stack.
   */
  history: Step[];
  /**
   * Onboarding "I already have bottles": the self-declared number of bottles on hand
   * (own or another brand's — we re-label them as ours). Carried until the order is
   * created; committed to the client only on dispatcher acceptance (deferred commit).
   * Its presence (>0) makes the first order an OWN_TARA order.
   */
  claimedOnHand?: number;
  /** Electric pump in the starter kit (T5). */
  electro?: boolean;
  /** Pump add-on for own bottles (T5, answer "no pump"). */
  pumpAddon?: boolean;
  /**
   * Optional client note about this order ("➕ Коментар до замовлення" on Confirm),
   * e.g. an availability window. Carried until the order is created; distinct from the
   * address comment (a permanent hint about the point). Cleared on resetSession.
   */
  orderNote?: string;
  /**
   * Edit mode: the client opened "✏️ Змінити" on Confirm and is changing a single
   * field. While true, field-input handlers return to Confirm instead of continuing
   * the linear flow. Cleared on reaching Confirm (renderConfirm) and on resetSession.
   */
  editing?: boolean;
  /**
   * Standalone address management ("📍 Моя адреса" menu, not an order): the
   * address/comment steps save the default address and return to the menu instead of
   * continuing to quantity selection. Cleared on resetSession.
   */
  managingAddress?: boolean;
  /**
   * message_id of the last sent inline scenario screen. On any transition away
   * from it we strip the keyboard so no "dead" buttons hang in the chat (tapping
   * them is already blocked by step guards, but it looks confusing).
   */
  activeInlineMessageId?: number;
}

type BotContext = Context & SessionFlavor<SessionData>;

// Callback button identifiers.
const CB_CONFIRM_YES = 'confirm:yes';
const CB_BACK = 'nav:back';
const CB_CANCEL = 'nav:cancel';
const CB_SKIP = 'nav:skip';
const CB_EDIT = 'nav:edit';
const CB_EDIT_BACK = 'nav:editback';
const CB_NOTE_ADD = 'note:add';
const CB_NOTE_BACK = 'note:back';
const CB_NOTE_CLEAR = 'note:clear';

// Reply button labels of the main menu (also the keys of the text router).
const BTN_ORDER = '🚰 Замовити воду';
const BTN_HISTORY = '📋 Мої замовлення';
const BTN_PRICES = '💰 Ціни';
const BTN_ADDRESS = '📍 Моя адреса';
const BTN_CONTACTS = '📞 Зв’язатися';

/** Max bottles via buttons (3+ still goes at the same price, SPEC §3.1). */
const MAX_QTY = 5;

const contactKeyboard = new Keyboard()
  .requestContact('📱 Поділитися номером')
  .resized()
  .oneTime();

/** Persistent reply menu — global navigation, always visible (SPEC §6). */
const mainReplyKeyboard = new Keyboard()
  .text(BTN_ORDER)
  .row()
  .text(BTN_HISTORY)
  .text(BTN_PRICES)
  .row()
  .text(BTN_ADDRESS)
  .text(BTN_CONTACTS)
  .resized()
  .persistent();

/**
 * Quantity selection keyboard (SPEC §6): optional "Repeat last order" button,
 * a row of digits 1..MAX_QTY, a navigation row. The repeat button sends the same
 * `qty:N` as the digits, so no separate handler is needed (N may exceed MAX_QTY).
 */
function buildQtyKeyboard(repeatN: number | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (repeatN) {
    kb.text(texts.repeatButton(repeatN), `qty:${repeatN}`).row();
  }
  for (let n = 1; n <= MAX_QTY; n += 1) {
    kb.text(String(n), `qty:${n}`);
  }
  kb.row().text('◀ Назад', CB_BACK).text('❌ Скасувати', CB_CANCEL);
  return kb;
}

/**
 * Cancel buttons under the "My orders" list: one per order in CREATED status
 * (the dispatcher has not accepted yet — the client can cancel it, SPEC §9). If
 * there is nothing to cancel — undefined (the list goes as plain text without an
 * inline keyboard).
 */
function buildHistoryKeyboard(orders: Order[]): InlineKeyboard | undefined {
  const cancellable = orders.filter((o) => o.status === OrderStatus.CREATED);
  if (!cancellable.length) return undefined;
  const kb = new InlineKeyboard();
  for (const o of cancellable) {
    kb.text(texts.cancelOrderButton(o), `ocancel:${o.id}`).row();
  }
  return kb;
}

/** Under the address prompt — only "Cancel" (from the first step, "back" = exit). */
const addressKeyboard = new InlineKeyboard().text('❌ Скасувати', CB_CANCEL);

/** Under "📍 Моя адреса": change the saved address (standalone, returns to the menu). */
const addressViewKeyboard = new InlineKeyboard().text(
  '✏️ Змінити адресу',
  'addr:edit',
);

/** Under the address comment prompt: skip (comment is optional) / cancel. */
const commentKeyboard = new InlineKeyboard()
  .text('⏭ Пропустити', CB_SKIP)
  .text('❌ Скасувати', CB_CANCEL);

/**
 * Order confirmation: confirm / edit / cancel + an order-note row (SPEC §6). The note
 * button label reflects whether a note is already set (add vs change), so the client
 * sees their note is saved without re-reading the whole screen.
 */
function buildConfirmKeyboard(hasNote: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Усе вірно, замовляю', CB_CONFIRM_YES)
    .row()
    .text(
      hasNote ? '📝 Коментар до замовлення ✅' : '➕ Коментар до замовлення',
      CB_NOTE_ADD,
    )
    .row()
    .text('✏️ Змінити', CB_EDIT)
    .text('❌ Скасувати', CB_CANCEL);
}

/** Under the order-note prompt: back to Confirm, and clear the note if one is set. */
function buildOrderNoteKeyboard(hasNote: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasNote) kb.text('🗑 Прибрати коментар', CB_NOTE_CLEAR).row();
  kb.text('◀ Назад', CB_NOTE_BACK);
  return kb;
}

/**
 * Edit menu (from "✏️ Змінити" on Confirm): pick the field to change. After editing,
 * the flow returns to Confirm. The pump row is shown only for the starter kit
 * (`showPump`) — for repeat/own-bottles orders there is no pump choice to change.
 */
function buildEditMenuKeyboard(showPump: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('📦 Кількість', 'ed:qty')
    .row()
    .text('📍 Адресу', 'ed:addr')
    .row()
    .text('📝 Коментар', 'ed:comment')
    .row();
  if (showPump) kb.text('🔌 Помпу', 'ed:pump').row();
  kb.text('◀ Назад', CB_EDIT_BACK).text('❌ Скасувати', CB_CANCEL);
  return kb;
}

/** New-client onboarding: "what do you already have" (PRODUCT.md). */
const onboardingKeyboard = new InlineKeyboard()
  .text('🆕 Стартовий комплект', 'ob:kit')
  .row()
  .text('💧 У мене вже є баки (19 л)', 'ob:own')
  .row()
  .text('⚙️ Інше', 'ob:other')
  .row()
  .text('❌ Скасувати', CB_CANCEL);

/** Under the manual own-bottles count input (OWN_TARA, "Інша кількість") — only cancel. */
const ownTaraKeyboard = new InlineKeyboard().text('❌ Скасувати', CB_CANCEL);

/**
 * Own-bottles count selection (OWN_TARA): digits 1..MAX_QTY as buttons + "Інша
 * кількість" for a larger number (typed as text) + cancel. Buttons by default keep the
 * non-advanced audience off free text (UX P1/A3); the manual path stays for 6+ bottles.
 */
function buildOwnTaraKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let n = 1; n <= MAX_QTY; n += 1) {
    kb.text(String(n), `tara:${n}`);
  }
  kb.row().text('✏️ Інша кількість', 'tara:more');
  kb.row().text('❌ Скасувати', CB_CANCEL);
  return kb;
}

/** Pump choice in the starter kit: standard / electric (T5). */
const pumpChoiceKeyboard = new InlineKeyboard()
  .text('Звичайна', 'pump:std')
  .text('Електро', 'pump:electro')
  .row()
  .text('❌ Скасувати', CB_CANCEL);

/** Own bottles: do you have a pump (T5). */
const ownPumpKeyboard = new InlineKeyboard()
  .text('Помпа є', 'yn:yes')
  .text('Потрібна помпа', 'yn:no')
  .row()
  .text('❌ Скасувати', CB_CANCEL);

/**
 * Client bot (SPEC §6): a grammY instance on CLIENT_BOT_TOKEN, long polling.
 * The FSM is implemented on top of grammY's in-memory session — on restart the
 * dialog starts over, which is acceptable for the MVP (SPEC §9). Data access is
 * only through module services; the bot never hits the DB directly (CLAUDE.md §6).
 *
 * Navigation: the persistent reply menu = global transitions (they cancel the
 * active order), inline "Back"/"Cancel" buttons = transitions inside the order scenario.
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
      this.logger.warn('CLIENT_BOT_TOKEN is not set — client bot not started');
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

    // start() resolves only when the bot stops — do NOT await, or init would hang.
    void bot.start({
      onStart: (me) =>
        this.logger.log(`client-bot @${me.username} started (long polling)`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  /**
   * Notifies the client about a status change of their order by the dispatcher
   * (SPEC §8). Listens to the OrdersService event. A send failure (client blocked
   * the bot, deleted the chat) is logged but not rethrown — it must not break the
   * dispatcher's status transition (CLAUDE.md rule 9).
   */
  @OnEvent(ORDER_STATUS_CHANGED)
  async onOrderStatusChanged(event: OrderStatusChangedEvent): Promise<void> {
    if (!this.bot) return;
    const text = texts.orderStatusUpdate(event.order);
    if (!text) return;
    // The listener is fire-and-forget (emit does not wait): swallow any error
    // (DB, blocked bot) here, otherwise it becomes an unhandled rejection.
    try {
      const client = await this.clients.getById(event.order.clientId);
      if (!client) return;
      await this.bot.api.sendMessage(String(client.telegramId), text);
    } catch (err) {
      this.logger.warn(
        `failed to notify client about order ${event.order.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Notifies the client that the dispatcher edited their order (quantity / address /
   * comment). Same fire-and-forget contract as {@link onOrderStatusChanged}: any send
   * failure is logged, never rethrown (CLAUDE.md rule 9/10).
   */
  @OnEvent(ORDER_EDITED)
  async onOrderEdited(event: OrderEditedEvent): Promise<void> {
    if (!this.bot) return;
    const text = texts.orderEdited(event.order);
    try {
      const client = await this.clients.getById(event.order.clientId);
      if (!client) return;
      await this.bot.api.sendMessage(String(client.telegramId), text);
    } catch (err) {
      this.logger.warn(
        `failed to notify client about edited order ${event.order.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Notifies the client about the delivery-timing message the dispatcher set for their
   * order (🕒 "сьогодні" / "перенесено на завтра" / …). Same fire-and-forget contract
   * as {@link onOrderStatusChanged}. A blank note yields no text — nothing is sent.
   */
  @OnEvent(ORDER_DELIVERY_NOTE)
  async onOrderDeliveryNote(event: OrderDeliveryNoteEvent): Promise<void> {
    if (!this.bot) return;
    const text = texts.deliveryNoteUpdate(event.order);
    if (!text) return;
    try {
      const client = await this.clients.getById(event.order.clientId);
      if (!client) return;
      await this.bot.api.sendMessage(String(client.telegramId), text);
    } catch (err) {
      this.logger.warn(
        `failed to notify client about delivery note for order ${event.order.id}: ${(err as Error).message}`,
      );
    }
  }

  private registerHandlers(bot: Bot<BotContext>): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on('message:contact', (ctx) => this.onContact(ctx));
    bot.callbackQuery(/^ob:(kit|own|other)$/, (ctx) =>
      this.onOnboardingChoice(ctx),
    );
    bot.callbackQuery(/^pump:(std|electro)$/, (ctx) => this.onPumpChoice(ctx));
    bot.callbackQuery(/^tara:(\d+|more)$/, (ctx) => this.onOwnTaraChoice(ctx));
    bot.callbackQuery(/^yn:(yes|no)$/, (ctx) => this.onOwnPumpAnswer(ctx));
    bot.callbackQuery(/^qty:([1-9]\d*)$/, (ctx) => this.onChooseQty(ctx));
    bot.callbackQuery(CB_CONFIRM_YES, (ctx) => this.onConfirmYes(ctx));
    bot.callbackQuery(CB_EDIT, (ctx) => this.onEdit(ctx));
    bot.callbackQuery(CB_EDIT_BACK, (ctx) => this.onEditBack(ctx));
    bot.callbackQuery(CB_NOTE_ADD, (ctx) => this.onAddOrderNote(ctx));
    bot.callbackQuery(CB_NOTE_BACK, (ctx) => this.onOrderNoteBack(ctx));
    bot.callbackQuery(CB_NOTE_CLEAR, (ctx) => this.onOrderNoteClear(ctx));
    bot.callbackQuery(/^ed:(qty|addr|comment|pump)$/, (ctx) =>
      this.onEditChoice(ctx),
    );
    bot.callbackQuery('addr:edit', (ctx) => this.onManageAddressStart(ctx));
    bot.callbackQuery(CB_BACK, (ctx) => this.onBack(ctx));
    bot.callbackQuery(CB_CANCEL, (ctx) => this.onCancel(ctx));
    bot.callbackQuery(CB_SKIP, (ctx) => this.onSkipComment(ctx));
    bot.callbackQuery(/^ocancel:(.+)$/, (ctx) => this.onCancelOwnOrder(ctx));
    // message:text is registered AFTER command('start') so /start does not fall here.
    bot.on('message:text', (ctx) => this.onText(ctx));
    // Fallback for NON-text messages (photo/geo/sticker): caught last, since the
    // text/contact handlers above break the chain for their own types.
    bot.on('message', (ctx) => this.onNonTextMessage(ctx));
  }

  /** /start: take a known client to the menu, a new one to the contact request. */
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

  /** Contact received: register the client and show the menu (AWAIT_CONTACT). */
  private async onContact(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;
    const contact = ctx.message?.contact;
    if (!contact) return;
    // Accept only the user's own contact (SPEC §9).
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

    // New client (no orders and no state) → straight to onboarding, not the menu (STEP3 T3).
    if (await this.needsOnboarding(client)) {
      await this.renderOnboarding(ctx);
      return;
    }
    await this.showMainMenu(ctx, client.name);
  }

  /**
   * Whether the client needs onboarding: not yet set up (no own bottles, no pump)
   * and no non-cancelled orders. This decides whether to show the "what do you have" screen.
   */
  private async needsOnboarding(client: Client): Promise<boolean> {
    if (client.bottlesOnHand > 0 || client.hasPump) return false;
    return (await this.orders.lastBottles(client.id)) === null;
  }

  /**
   * Single text entry point: first the reply menu buttons (global navigation,
   * SPEC §6), then — address input (AwaitAddress) or comment input (AwaitComment).
   * A button match takes priority, so "💰 Ціни" is not stored as an address/comment.
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
      case BTN_ADDRESS:
        await this.showAddress(ctx);
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
    } else if (ctx.session.step === Step.OwnTaraCount) {
      await this.onOwnTaraCountInput(ctx, text);
    } else if (ctx.session.step === Step.AwaitOrderNote) {
      await this.onOrderNoteInput(ctx, text);
    }
  }

  /**
   * Non-text message (photo, geo, voice, sticker). If we are waiting for the
   * address or comment — gently ask to send text (we leave the active screen with
   * its "Cancel" alone so it can be exited). In other states — ignore.
   */
  private async onNonTextMessage(ctx: BotContext): Promise<void> {
    const step = ctx.session.step;
    if (
      step === Step.AwaitAddress ||
      step === Step.AwaitComment ||
      step === Step.OwnTaraCount ||
      step === Step.AwaitOrderNote
    ) {
      await ctx.reply(texts.sendAsText);
    }
  }

  /** Address entered (AWAIT_ADDRESS): remember raw and go collect the comment. */
  private async onAddressInput(ctx: BotContext, raw: string): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    if (ctx.session.editing) {
      // Edit mode: update only the address (keep the existing comment) and go back
      // to Confirm — no second pass through the comment step. On a raw change
      // setDefaultAddress drops a now-stale dispatcher pin (it pointed at the old place).
      const addr = await this.clients.getDefaultAddress(client.id);
      await this.clients.setDefaultAddress(client.id, {
        raw,
        comment: addr?.comment ?? null,
      });
      await this.returnToConfirm(ctx);
      return;
    }
    ctx.session.addressRaw = raw;
    this.pushHistory(ctx, Step.AwaitAddress);
    await this.renderCommentPrompt(ctx);
  }

  /** "Skip" the comment (AWAIT_COMMENT): create the address without a comment. */
  private async onSkipComment(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.AwaitComment) return;
    await this.finalizeAddress(ctx, null);
  }

  /**
   * Finishes collecting the address: creates the default address with an optional
   * comment and leads to quantity selection. addressRaw stays in the session until
   * the scenario exits (resetSession), so "Back" to the comment step still has the address.
   */
  private async finalizeAddress(
    ctx: BotContext,
    comment: string | null,
  ): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    if (ctx.session.editing) {
      // Edit mode: update only the comment (keep the saved address) and go back to Confirm.
      const addr = await this.clients.getDefaultAddress(client.id);
      if (addr) {
        await this.clients.setDefaultAddress(client.id, {
          raw: addr.raw,
          comment,
        });
      }
      await this.returnToConfirm(ctx);
      return;
    }
    if (ctx.session.managingAddress) {
      // Standalone address management ("📍 Моя адреса"): save the default address and
      // return to the menu (no quantity step). A shared pin (session geo) is written too.
      const raw = ctx.session.addressRaw;
      if (!raw) {
        await this.renderAddressPrompt(ctx);
        return;
      }
      await this.clients.setDefaultAddress(client.id, { raw, comment });
      this.resetSession(ctx, Step.MainMenu);
      await this.replyMenu(ctx, texts.addressSaved);
      return;
    }
    const raw = ctx.session.addressRaw;
    const intent = resolveFinalizeAddress(raw);
    if (intent.kind === 'choose-qty') {
      // upsert, not create: re-running the step ("Back") does not produce dupes.
      // raw is definitely set (choose-qty ⇒ !!raw) — guard for narrowing.
      if (raw)
        await this.clients.setDefaultAddress(client.id, { raw, comment });
      this.pushHistory(ctx, Step.AwaitComment);
    }
    await this.renderScreen(ctx, intent, { client });
  }

  /**
   * "Order water": the global entry into the scenario. Resets the previous flow,
   * then per {@link resolveStartOrder}: no address → collect it (first order); has
   * address and a previous order → straight to confirmation with the previous
   * quantity (one-tap repeat); has address but no orders → quantity selection.
   */
  private async startOrder(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;

    // A first OWN_TARA order is awaiting review: its declared balance is not committed
    // yet (deferred commit), so a new order would misprice the tara. Block until the
    // dispatcher accepts (which commits the balance and clears pendingReview).
    if (client.pendingReview) {
      await this.replyMenu(ctx, texts.awaitingFirstOrderReview);
      return;
    }

    ctx.session.bottles = undefined;
    ctx.session.history = [Step.MainMenu];

    const address = await this.clients.getDefaultAddress(client.id);
    const lastBottles = address
      ? await this.orders.lastBottles(client.id)
      : null;
    const needsOnboarding =
      lastBottles === null && client.bottlesOnHand === 0 && !client.hasPump;
    const intent = resolveStartOrder(
      address !== null,
      lastBottles,
      needsOnboarding,
    );
    if (intent.kind === 'confirm') {
      // Substitute the previous quantity and push the quantity-selection step into
      // history so "✏️ Edit" (= "Back") leads to it rather than to the menu.
      ctx.session.bottles = intent.bottles;
      this.pushHistory(ctx, Step.ChooseQty);
    }
    await this.renderScreen(ctx, intent, { client, address });
  }

  /**
   * Choice on the onboarding screen (PRODUCT.md). kit → the starter-kit flow;
   * own → own-bottles count input (OWN_TARA, whether the bottles are ours or another
   * brand's — we re-label them); other → dispatcher callback. The order kind is derived
   * from the declared count (claimedOnHand), so it is not separately flagged here.
   */
  private async onOnboardingChoice(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Onboarding) return;
    const choice = parseOnboardingChoice(ctx.match?.[1] ?? '');
    if (choice === null) return;
    const client = await this.requireClient(ctx);
    if (!client) return;

    ctx.session.bottles = undefined;
    ctx.session.history = [Step.MainMenu];
    ctx.session.claimedOnHand = undefined;
    switch (choice) {
      case 'kit':
        await this.renderPumpChoice(ctx);
        return;
      case 'own':
        await this.renderOwnTaraCount(ctx);
        return;
      case 'other': {
        // Non-standard — handled by the dispatcher (by call). Notify the dispatcher
        // to call back; best-effort: the client gets the support phone either way (§8).
        const phone =
          this.config.get<string>('SUPPORT_PHONE') ?? '(телефон уточнюється)';
        this.resetSession(ctx, Step.MainMenu);
        try {
          await this.orders.requestCallback(client.id);
        } catch (err) {
          this.logger.warn(
            `requestCallback failed for client ${client.id}: ${(err as Error).message}`,
          );
        }
        await this.replyMenu(ctx, texts.onboardingToDispatcher(phone));
        return;
      }
    }
  }

  /**
   * Own-bottles count via buttons (OWN_TARA, step OwnTaraCount). A digit sets the count;
   * "Інша кількість" switches to manual text entry (for 6+ bottles). See
   * {@link onOwnTaraCountInput} for how the declared count is treated (deferred commit).
   */
  private async onOwnTaraChoice(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.OwnTaraCount) return;
    const choice = parseTaraChoice(ctx.match?.[1] ?? '');
    if (choice === null) return;
    if (choice === 'more') {
      await this.renderOwnTaraManual(ctx);
      return;
    }
    ctx.session.claimedOnHand = choice;
    await this.renderOwnPumpAsk(ctx);
  }

  /**
   * Own-bottles count typed as text (OWN_TARA, step OwnTaraCount, "Інша кількість" path).
   * The declared count is kept in the session (NOT written to the client yet — deferred
   * commit) and makes the order OWN_TARA; it is committed to the client's balance only
   * when the dispatcher accepts the order. Then we always ask about the pump.
   */
  private async onOwnTaraCountInput(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    const count = parseTaraCount(text);
    if (count === null) {
      await ctx.reply(texts.ownTaraInvalid);
      return;
    }
    ctx.session.claimedOnHand = count;
    await this.renderOwnPumpAsk(ctx);
  }

  /** Pump choice in the starter kit (T5): standard / electric. */
  private async onPumpChoice(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.PumpChoice) return;
    const choice = parsePumpChoice(ctx.match?.[1] ?? '');
    if (choice === null) return;
    ctx.session.electro = choice === 'electro';
    if (ctx.session.editing) {
      await this.returnToConfirm(ctx);
      return;
    }
    await this.renderAddressPrompt(ctx);
  }

  /** Own bottles: do you have a pump (T5). "No" → add the pump to the order. */
  private async onOwnPumpAnswer(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.OwnPumpAsk) return;
    const hasPump = parseYesNo(ctx.match?.[1] ?? '');
    if (hasPump === null) return;
    ctx.session.pumpAddon = hasPump === false;
    await this.renderAddressPrompt(ctx);
  }

  /**
   * "My orders": the client's latest orders (SPEC §6). Interrupts the active order.
   * Under orders in CREATED status — cancel buttons (SPEC §9); if there are none,
   * the list goes as plain text with the reply menu.
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
   * Cancel one's own order from the list (SPEC §9). Owner and status are checked
   * in the service; here — a toast about the result and a redraw of the list in place.
   */
  private async onCancelOwnOrder(ctx: BotContext): Promise<void> {
    const orderId = ctx.match?.[1];
    const client = await this.requireClient(ctx);
    if (!client || !orderId) {
      await ctx.answerCallbackQuery();
      return;
    }
    let toast: string;
    try {
      await this.orders.cancelOwnOrder(orderId, client.id);
      toast = 'Замовлення скасовано';
    } catch {
      // Already accepted/delivered/foreign — cannot be cancelled.
      toast = 'Це замовлення вже не можна скасувати';
    }
    await ctx.answerCallbackQuery({ text: toast });

    // Redraw the list in place either way (UX A1 — no dead ends): on success it drops
    // the cancelled order's button; on failure it refreshes now-stale buttons so the
    // client is not left tapping one that keeps failing.
    const orders = await this.orders.listByClient(client.id);
    const text = orders.length ? texts.history(orders) : texts.historyEmpty;
    const kb = buildHistoryKeyboard(orders);
    try {
      await ctx.editMessageText(text, kb ? { reply_markup: kb } : undefined);
      if (!kb) ctx.session.activeInlineMessageId = undefined;
    } catch {
      // Message too old to edit — the client already saw the toast.
    }
  }

  /** "Prices": the current grid from PriceSettings (SPEC §6). Interrupts the active order. */
  private async showPrices(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const prices = await this.pricingSettings.getCurrent();
    await this.replyMenu(ctx, texts.prices(prices));
  }

  /** "Contact us": support phone from config (SPEC §6, §11). */
  private async showContacts(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const phone =
      this.config.get<string>('SUPPORT_PHONE') ?? '(телефон уточнюється)';
    await this.replyMenu(ctx, texts.contacts(phone));
  }

  /**
   * "📍 Моя адреса": show the saved default address (with a change button). No saved
   * address yet → go straight into entering one. Interrupts an active order (global nav).
   */
  private async showAddress(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.leaveOrderFlow(ctx);

    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      // Nothing saved — start collecting it (standalone, returns to the menu).
      ctx.session.managingAddress = true;
      ctx.session.history = [Step.MainMenu];
      await this.renderAddressPrompt(ctx);
      return;
    }
    await this.replyInline(
      ctx,
      texts.addressView(address),
      addressViewKeyboard,
    );
  }

  /** "✏️ Змінити адресу": enter standalone address editing (returns to the menu). */
  private async onManageAddressStart(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;
    ctx.session.managingAddress = true;
    ctx.session.history = [Step.MainMenu];
    await this.renderAddressPrompt(ctx);
  }

  /** Quantity chosen: compute the price preview and show the confirmation. */
  private async onChooseQty(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.ChooseQty) return;
    // Validation of the untrusted callback (SPEC §7) — in the pure parseQty.
    const bottles = parseQty(ctx.match?.[1] ?? '');
    if (bottles === null) return;

    const client = await this.requireClient(ctx);
    if (!client) return;
    const address = await this.clients.getDefaultAddress(client.id);
    const intent = resolveAfterQty(bottles, address !== null);
    if (intent.kind === 'confirm') {
      ctx.session.bottles = intent.bottles;
      this.pushHistory(ctx, Step.ChooseQty);
    }
    await this.renderScreen(ctx, intent, { client, address });
  }

  /** Order confirmation. The step leaves Confirm immediately — guard against a double tap. */
  private async onConfirmYes(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Confirm) return; // idempotency (SPEC §9)
    const bottles = ctx.session.bottles;

    const client = await this.requireClient(ctx);
    if (!client) return;
    if (!bottles) {
      await this.showMainMenu(ctx, client.name);
      return;
    }
    // Order options — read before resetSession (it clears them). claimedOnHand makes
    // a first order OWN_TARA and is committed to the client only on dispatcher accept.
    const pumpOpts = {
      electro: ctx.session.electro,
      pumpAddon: ctx.session.pumpAddon,
      claimedOnHand: ctx.session.claimedOnHand,
    };
    const note = ctx.session.orderNote;
    // Leave Confirm BEFORE creating the order — a repeat tap won't create a dupe.
    this.resetSession(ctx, Step.MainMenu);

    try {
      await this.orders.createOrder(client.id, bottles, pumpOpts, note);
    } catch (err) {
      // Creation failure (DB/race) — don't stay silent: the client must understand
      // the order was not placed and retry (quantity already reset — they re-order).
      this.logger.error(
        `createOrder failed for client ${client.id}: ${(err as Error).message}`,
      );
      await this.replyMenu(ctx, texts.orderError);
      return;
    }
    await this.renderScreen(ctx, { kind: 'order-done' }, { client });
  }

  /**
   * "✏️ Змінити" on Confirm: open the edit menu (pick the field to change). The pump
   * row is shown only for the starter kit — `session.electro` is set (boolean) only
   * on that branch, undefined for repeat/own-bottles orders.
   */
  private async onEdit(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Confirm) return;
    await this.renderEditMenu(ctx);
  }

  /**
   * Edit menu choice: enter edit mode and open the matching field screen. The
   * field's input handler returns to Confirm afterwards (see `editing` flag).
   */
  private async onEditChoice(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.EditMenu) return;
    const field = parseEditField(ctx.match?.[1] ?? '');
    if (field === null) return;
    const client = await this.requireClient(ctx);
    if (!client) return;
    ctx.session.editing = true;
    switch (field) {
      case 'qty':
        await this.renderChooseQty(ctx, client.id);
        return;
      case 'addr':
        await this.renderAddressPrompt(ctx);
        return;
      case 'comment':
        await this.renderCommentPrompt(ctx);
        return;
      case 'pump':
        await this.renderPumpChoice(ctx);
        return;
    }
  }

  /** "◀ Назад" on the edit menu: return to Confirm without changing anything. */
  private async onEditBack(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.EditMenu) return;
    await this.returnToConfirm(ctx);
  }

  /**
   * Re-renders Confirm after a single-field edit. Loads the (now updated) default
   * address; if it somehow disappeared, falls back to the address prompt (staying in
   * edit mode). renderConfirm clears the `editing` flag.
   */
  private async returnToConfirm(ctx: BotContext): Promise<void> {
    const client = await this.requireClient(ctx);
    if (!client) return;
    const address = await this.clients.getDefaultAddress(client.id);
    if (!address) {
      await this.renderAddressPrompt(ctx);
      return;
    }
    await this.renderConfirm(ctx, client.id, address);
  }

  /**
   * "➕ Коментар до замовлення" on Confirm: open the note prompt. A side-branch off
   * Confirm (like the edit menu) — the text handler saves the note and returns here.
   */
  private async onAddOrderNote(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.Confirm) return;
    await this.renderOrderNotePrompt(ctx);
  }

  /** Order-note text entered (AWAIT_ORDER_NOTE): save it and return to Confirm. */
  private async onOrderNoteInput(ctx: BotContext, text: string): Promise<void> {
    ctx.session.orderNote = text;
    await this.returnToConfirm(ctx);
  }

  /** "◀ Назад" under the note prompt: return to Confirm without changing the note. */
  private async onOrderNoteBack(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.AwaitOrderNote) return;
    await this.returnToConfirm(ctx);
  }

  /** "🗑 Прибрати коментар" under the note prompt: clear the note and return to Confirm. */
  private async onOrderNoteClear(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    if (ctx.session.step !== Step.AwaitOrderNote) return;
    ctx.session.orderNote = undefined;
    await this.returnToConfirm(ctx);
  }

  /** "Back" on the quantity screen: one step back along the history stack. */
  private async onBack(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;

    const prev = ctx.session.history.pop();
    // The address only matters for the quantity branch — load it only there.
    const hasDefaultAddress =
      prev === Step.ChooseQty
        ? (await this.clients.getDefaultAddress(client.id)) !== null
        : false;
    // resolveBack decides "where", renderScreen — "how". BackTarget is a subset of
    // ScreenIntent['kind']; adapt it to the intent (main-menu carries the client name).
    const target = resolveBack(prev, hasDefaultAddress);
    const intent: ScreenIntent =
      target === 'main-menu'
        ? { kind: 'main-menu', name: client.name }
        : target === 'comment-prompt'
          ? { kind: 'comment-prompt' }
          : target === 'choose-qty'
            ? { kind: 'choose-qty' }
            : { kind: 'address-prompt' };
    await this.renderScreen(ctx, intent, { client });
  }

  /** "Cancel": exit the order scenario back to the main menu. */
  private async onCancel(ctx: BotContext): Promise<void> {
    await ctx.answerCallbackQuery();
    const client = await this.requireClient(ctx);
    if (!client) return;
    this.resetSession(ctx, Step.MainMenu);
    await this.replyMenu(ctx, texts.orderCancelled);
  }

  // --- Screen render helpers: set the step and draw (SPEC §6) -----------------

  /**
   * The only place where a ScreenIntent becomes a real screen (SPEC §6).
   * An exhaustive switch with `default: assertNever(intent)`: a screen forgotten
   * when adding a new one is caught by the compiler, not at runtime. Data requiring
   * an async load (client, address) arrives ready in `deps` from the handler —
   * here is only rendering, no service calls.
   *
   * `await-contact` is also rendered directly in onStart/requireClient (where there
   * is no client yet) — the case is kept here for dictionary completeness and future routing.
   */
  private async renderScreen(
    ctx: BotContext,
    intent: ScreenIntent,
    deps: { client: Client; address?: Address | null },
  ): Promise<void> {
    switch (intent.kind) {
      case 'await-contact':
        this.resetSession(ctx, Step.AwaitContact);
        await this.replyMenu(ctx, texts.awaitContact, contactKeyboard);
        return;
      case 'main-menu':
        await this.showMainMenu(ctx, intent.name);
        return;
      case 'onboarding':
        await this.renderOnboarding(ctx);
        return;
      case 'own-tara-count':
        await this.renderOwnTaraCount(ctx);
        return;
      case 'pump-choice':
        await this.renderPumpChoice(ctx);
        return;
      case 'own-pump-ask':
        await this.renderOwnPumpAsk(ctx);
        return;
      case 'address-prompt':
        await this.renderAddressPrompt(ctx);
        return;
      case 'comment-prompt':
        await this.renderCommentPrompt(ctx);
        return;
      case 'choose-qty':
        await this.renderChooseQty(ctx, deps.client.id);
        return;
      case 'confirm':
        // confirm is returned only when an address exists (resolveAfterQty) —
        // guard for narrowing Address | null → Address.
        if (deps.address) {
          await this.renderConfirm(ctx, deps.client.id, deps.address);
        }
        return;
      case 'order-done':
        await this.replyMenu(ctx, texts.orderDone);
        return;
      default:
        assertNever(intent);
    }
  }

  private async showMainMenu(
    ctx: BotContext,
    name: string | null,
  ): Promise<void> {
    this.resetSession(ctx, Step.MainMenu);
    await this.replyMenu(ctx, texts.mainMenu(name));
  }

  private async renderOnboarding(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.Onboarding;
    await this.replyInline(ctx, texts.onboarding, onboardingKeyboard);
  }

  /** Own-bottles count — button screen (default). */
  private async renderOwnTaraCount(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.OwnTaraCount;
    await this.replyInline(ctx, texts.ownTaraChoose, buildOwnTaraKeyboard());
  }

  /** Own-bottles count — manual text entry ("Інша кількість"); same step, cancel only. */
  private async renderOwnTaraManual(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.OwnTaraCount;
    await this.replyInline(ctx, texts.ownTaraCount, ownTaraKeyboard);
  }

  private async renderPumpChoice(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.PumpChoice;
    const prices = await this.pricingSettings.getCurrent();
    await this.replyInline(ctx, texts.pumpChoice(prices), pumpChoiceKeyboard);
  }

  private async renderOwnPumpAsk(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.OwnPumpAsk;
    const prices = await this.pricingSettings.getCurrent();
    await this.replyInline(
      ctx,
      texts.ownPumpAsk(prices.pumpPrice),
      ownPumpKeyboard,
    );
  }

  private async renderAddressPrompt(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.AwaitAddress;
    // "First order" wording only for a genuine first address; changing an existing one
    // (standalone management or editing on Confirm) uses neutral copy.
    const changing = ctx.session.managingAddress || ctx.session.editing;
    const prompt = changing ? texts.changeAddress : texts.awaitAddress;
    await this.replyInline(ctx, prompt, addressKeyboard);
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

  private async renderEditMenu(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.EditMenu;
    // Pump is part of the starter kit only; electro is a boolean on that branch.
    const showPump = ctx.session.electro !== undefined;
    await this.replyInline(
      ctx,
      texts.editMenu,
      buildEditMenuKeyboard(showPump),
    );
  }

  private async renderOrderNotePrompt(ctx: BotContext): Promise<void> {
    ctx.session.step = Step.AwaitOrderNote;
    await this.replyInline(
      ctx,
      texts.orderNotePrompt,
      buildOrderNoteKeyboard(!!ctx.session.orderNote),
    );
  }

  private async renderConfirm(
    ctx: BotContext,
    clientId: string,
    address: Address,
  ): Promise<void> {
    const intent = resolveConfirm(ctx.session.bottles);
    if (intent.kind === 'choose-qty') {
      await this.renderChooseQty(ctx, clientId);
      return;
    }
    const quote = await this.orders.quote(clientId, intent.bottles, {
      electro: ctx.session.electro,
      pumpAddon: ctx.session.pumpAddon,
      claimedOnHand: ctx.session.claimedOnHand,
    });
    // Reaching Confirm ends any single-field edit (covers the edit-quantity path too).
    ctx.session.editing = false;
    ctx.session.step = Step.Confirm;
    await this.replyInline(
      ctx,
      texts.confirm(quote, address, ctx.session.orderNote),
      buildConfirmKeyboard(!!ctx.session.orderNote),
    );
  }

  // --- Sending screens with cleanup of hanging inline buttons ----------------

  /**
   * Inline scenario screen: strips the previous screen's keyboard and remembers
   * the new message_id, so the next transition can strip its buttons too.
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
   * Screen with a reply menu (or a contact request): strips the scenario's hanging
   * inline keyboard. We do not remember its own message_id — a reply keyboard has none.
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
   * Strips the inline keyboard from the last scenario screen (if any).
   * Swallows the error (message deleted/too old) — it is not critical.
   */
  private async clearActiveInline(ctx: BotContext): Promise<void> {
    const id = ctx.session.activeInlineMessageId;
    ctx.session.activeInlineMessageId = undefined;
    if (id === undefined || !ctx.chat) return;
    try {
      await ctx.api.editMessageReplyMarkup(ctx.chat.id, id);
    } catch {
      // message already deleted/unavailable — ignore
    }
  }

  // --- Session management ----------------------------------------------------

  /**
   * Resets the local scenario state and sets the given step.
   * We do NOT touch `activeInlineMessageId` — it is managed by replyInline/replyMenu,
   * otherwise we would lose the id before stripping the keyboard from the message.
   */
  private resetSession(ctx: BotContext, step: Step): void {
    ctx.session.step = step;
    ctx.session.bottles = undefined;
    ctx.session.addressRaw = undefined;
    ctx.session.claimedOnHand = undefined;
    ctx.session.electro = undefined;
    ctx.session.pumpAddon = undefined;
    ctx.session.orderNote = undefined;
    ctx.session.editing = undefined;
    ctx.session.managingAddress = undefined;
    ctx.session.history = [];
  }

  /**
   * Leaving the active order scenario via a reply button (SPEC §6): if an order was
   * in progress, treat it as cancelled (the Order is not created yet — reset the session only).
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
   * Fetches the client by telegramId; if the bot does not know them (lost session,
   * a direct tap on an old button) — returns them to the contact request.
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

  /** Registers a client; if the phone is already known — reuse it (edge §9). */
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
