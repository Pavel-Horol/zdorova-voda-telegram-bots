import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from '../clients/clients.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import {
  ORDER_DISPATCHER,
  type OrderDispatcher,
} from '../../bots/shared/order-dispatcher';
import {
  ORDER_STATUS_CHANGED,
  ORDER_EDITED,
  ORDER_DELIVERY_NOTE,
  type OrderStatusChangedEvent,
  type OrderEditedEvent,
  type OrderDeliveryNoteEvent,
} from './order-events';
import { OrderStatus, OrderKind } from '../../../generated/prisma/enums';
import type { Order, Client, Address } from '../../../generated/prisma/client';

/** An order together with its client and address (for rendering at the dispatcher). */
export type OrderWithRelations = Order & { client: Client; address: Address };

/**
 * Order price preview BEFORE creating it (SPEC §6: CONFIRM_* screens).
 * The bot renders the confirmation from this data and does NOT compute money itself (CLAUDE.md §1).
 */
export interface OrderQuote {
  kind: OrderKind;
  bottles: number;
  totalPrice: number;
  /** Water price per bottle by grid — for a NON-kit order (for the text). */
  perBottle: number | null;
  /** How many bottles of the order are new tara under deposit (>0 → tara top-up, for the text). */
  newTara: number;
  /** Deposit per bottle — for the starter-kit breakdown. */
  depositPerBottle: number;
  /** Pump price — for the starter-kit breakdown. */
  pumpPrice: number;
  /** Electric pump price — for the electric-kit breakdown. */
  electroPumpPrice: number;
  /** Starter water per bottle — for the starter-kit breakdown. */
  waterStartPrice: number;
  /** Electric pump in the kit (for the confirmation text). */
  electro: boolean;
  /** Pump add-on for own bottles (for the confirmation text). */
  pumpAddon: boolean;
}

/**
 * Grouped operator summary for the dispatcher's /stats (SPEC §7). Money and volume
 * follow the "без скасованих" convention — CANCELLED orders count only under
 * `cancellations`. Rendered by `statsMessage()` (dispatcher-bot.texts.ts).
 */
export interface StatsSummary {
  /** Point-in-time queue: unhandled (CREATED) and in progress (ACCEPTED). */
  queue: { created: number; accepted: number };
  /** Today (from local midnight): order count, money and delivered bottles. */
  today: { count: number; sum: number; bottles: number };
  /** Rolling 7 days: order count, money and delivered bottles. */
  week: { count: number; sum: number; bottles: number };
  /** Rolling 30 days: order count and money. */
  month: { count: number; sum: number };
  /**
   * Cancellations by period, plus the week cancel rate (cancelled / all week
   * orders). `weekRate` is null when there were no week orders at all — the text
   * renders «—» (guards divide-by-zero).
   */
  cancellations: { today: number; week: number; weekRate: number | null };
}

/** Order pump options (the client's onboarding choice). */
export interface PumpOptions {
  electro?: boolean;
  pumpAddon?: boolean;
  /**
   * Bottles self-declared at onboarding ("I already have bottles"). When set (>0) on
   * a first order, the order is OWN_TARA and the balance is committed to the client
   * only on dispatcher acceptance (deferred commit — PRODUCT.md). The client record
   * is NOT touched at order creation.
   */
  claimedOnHand?: number;
}

/**
 * Orders: creation, price calculation (delegated), status transitions (SPEC §5, §7, §8).
 * The service ties together clients + pricing-settings + pricing, but does NOT compute
 * the total itself — that is done by PricingService (the single source of truth, CLAUDE.md §1).
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly pricing: PricingService,
    private readonly pricingSettings: PricingSettingsService,
    @Inject(ORDER_DISPATCHER) private readonly dispatcher: OrderDispatcher,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The client's latest orders for the "My orders" screen (SPEC §6). Read-only,
   * newest first, cancelled included (the client sees their status too).
   */
  listByClient(clientId: string, limit = 5): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * The bottle count of the client's last non-cancelled order — for the "Repeat last
   * order" button (SPEC §6). null if there is nothing to repeat (no orders or all
   * cancelled — then it is effectively a first order).
   */
  async lastBottles(clientId: string): Promise<number | null> {
    const last = await this.prisma.order.findFirst({
      where: { clientId, status: { not: OrderStatus.CANCELLED } },
      orderBy: { createdAt: 'desc' },
      select: { bottles: true },
    });
    return last?.bottles ?? null;
  }

  /**
   * Water price per bottle by the current grid for a given quantity (for the driver
   * hand-off line). Delegates to PricingService (the single source of truth) with the
   * current PriceSettings — informational, so it uses live prices, not the frozen total.
   */
  async waterUnitPrice(bottles: number): Promise<number> {
    const prices = await this.pricingSettings.getCurrent();
    return this.pricing.waterUnitPrice(bottles, prices);
  }

  /** Order with client and address — for redrawing the dispatcher's message (SPEC §7). */
  getOrderView(id: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { id },
      include: { client: true, address: true },
    });
  }

  /**
   * Read-only lookup by the short id shown on a card (`#a1b2c3d4`) — or a full uuid —
   * for the dispatcher's /order command: after an order leaves the active list it can
   * no longer be re-opened by button, only pulled up by id. The 8-char short id is the
   * uuid's leading hex, so a `startsWith` prefix match finds it; a full uuid matches
   * exactly. Loads the same relations as {@link getOrderView} so the card renders. The
   * prefix is validated/normalized by the handler (normalizeOrderIdArg) — this expects a
   * clean hex prefix. Returns ALL matches (a short prefix could, in theory, collide).
   */
  findByShortIdPrefix(prefix: string): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where: { id: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
      include: { client: true, address: true },
    });
  }

  /**
   * Active orders (created/accepted) for the dispatcher's /orders command: the work
   * queue if the push scrolled up the chat. Oldest first (FIFO). limit — a safeguard
   * against flooding the chat with messages.
   */
  listActive(limit = 20): Promise<OrderWithRelations[]> {
    return this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.CREATED, OrderStatus.ACCEPTED] },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { client: true, address: true },
    });
  }

  /**
   * Compact operator summary for /stats (SPEC §7). Everything follows the
   * "без скасованих" convention — CANCELLED orders never count toward volume or
   * money (only the dedicated cancellation figures count them). Periods: "today"
   * from local midnight, "week" a rolling 7 days, "month" a rolling 30 days.
   * "bottles" is the number of bottles actually DELIVERED in the period (a real
   * volume signal, unlike created-but-pending orders). Full analytics — later.
   */
  async stats(): Promise<StatsSummary> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const notCancelled = { status: { not: OrderStatus.CANCELLED } };
    const delivered = { status: OrderStatus.DELIVERED };
    const cancelled = { status: OrderStatus.CANCELLED };
    const since = (from: Date) => ({ createdAt: { gte: from } });

    const [
      queueCreated,
      queueAccepted,
      todayCount,
      todayAgg,
      todayBottles,
      weekCount,
      weekAgg,
      weekBottles,
      monthCount,
      monthAgg,
      todayCancelled,
      weekCancelled,
    ] = await this.prisma.$transaction([
      // Queue now: unhandled (CREATED) and in progress (ACCEPTED) — a point-in-time
      // snapshot, so no period filter.
      this.prisma.order.count({ where: { status: OrderStatus.CREATED } }),
      this.prisma.order.count({ where: { status: OrderStatus.ACCEPTED } }),
      // Today / week: order count + money (non-cancelled) and delivered bottles.
      this.prisma.order.count({
        where: { ...notCancelled, ...since(startOfToday) },
      }),
      this.prisma.order.aggregate({
        where: { ...notCancelled, ...since(startOfToday) },
        _sum: { totalPrice: true },
      }),
      this.prisma.order.aggregate({
        where: { ...delivered, ...since(startOfToday) },
        _sum: { bottles: true },
      }),
      this.prisma.order.count({
        where: { ...notCancelled, ...since(weekAgo) },
      }),
      this.prisma.order.aggregate({
        where: { ...notCancelled, ...since(weekAgo) },
        _sum: { totalPrice: true },
      }),
      this.prisma.order.aggregate({
        where: { ...delivered, ...since(weekAgo) },
        _sum: { bottles: true },
      }),
      // This month: count + money (non-cancelled).
      this.prisma.order.count({
        where: { ...notCancelled, ...since(monthAgo) },
      }),
      this.prisma.order.aggregate({
        where: { ...notCancelled, ...since(monthAgo) },
        _sum: { totalPrice: true },
      }),
      // Cancellations: today + week.
      this.prisma.order.count({
        where: { ...cancelled, ...since(startOfToday) },
      }),
      this.prisma.order.count({
        where: { ...cancelled, ...since(weekAgo) },
      }),
    ]);

    const weekSum = weekAgg._sum.totalPrice ?? 0;
    // Week cancel rate over all week orders (cancelled + non-cancelled). null when
    // there were no orders at all — the text renders it as «—» (no divide-by-zero).
    const weekTotalOrders = weekCount + weekCancelled;
    const cancelRate =
      weekTotalOrders > 0 ? weekCancelled / weekTotalOrders : null;

    return {
      queue: { created: queueCreated, accepted: queueAccepted },
      today: {
        count: todayCount,
        sum: todayAgg._sum.totalPrice ?? 0,
        bottles: todayBottles._sum.bottles ?? 0,
      },
      week: {
        count: weekCount,
        sum: weekSum,
        bottles: weekBottles._sum.bottles ?? 0,
      },
      month: { count: monthCount, sum: monthAgg._sum.totalPrice ?? 0 },
      cancellations: {
        today: todayCancelled,
        week: weekCancelled,
        weekRate: cancelRate,
      },
    };
  }

  /**
   * Creates an order with CREATED status and a fixed totalPrice (SPEC §8).
   * Prices are taken from PriceSettings at the moment of ordering and are not
   * recomputed retroactively (SPEC §3.3, §4).
   */
  async createOrder(
    clientId: string,
    bottles: number,
    opts: PumpOptions = {},
    note?: string | null,
  ): Promise<Order> {
    const client = await this.clients.getById(clientId);
    if (!client) {
      throw new Error(`client not found: ${clientId}`);
    }

    const address = await this.clients.getDefaultAddress(clientId);
    if (!address) {
      throw new Error(`client ${clientId} has no default address`);
    }

    // A self-declared claim is meaningful only when positive; 0/negative means "no
    // bottles" (STARTER_KIT) and must never flag review or commit a zero balance.
    const claimedOnHand = this.normalizeClaim(opts.claimedOnHand);
    const kind = await this.deriveKind(client, claimedOnHand);
    const prices = await this.pricingSettings.getCurrent();
    // For an OWN_TARA first order the balance is not committed yet (deferred commit) —
    // use the self-declared claim for the tara math; otherwise the client's balance.
    const bottlesOnHand = claimedOnHand ?? client.bottlesOnHand;
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      kind,
      prices,
      bottlesOnHand,
      opts,
    );
    // Snapshot how many bottles are new tara (deposit) at order time — bottlesOnHand
    // changes on later deliveries, so we cannot recompute it reliably afterwards.
    const newTara = this.pricing.newTara(bottles, kind, bottlesOnHand);

    const order = await this.prisma.order.create({
      data: {
        clientId,
        addressId: address.id,
        bottles,
        kind,
        newTara,
        electro: opts.electro ?? false,
        pumpAddon: opts.pumpAddon ?? false,
        // Self-declared balance to verify and commit on acceptance (OWN_TARA only).
        claimedOnHand: claimedOnHand ?? null,
        // Optional client note about this order (e.g. availability window). Does not
        // affect pricing — kept separate from the pump/tara opts.
        note: note ?? null,
        totalPrice,
        status: OrderStatus.CREATED,
      },
    });

    // OWN_TARA from a self-declared claim: flag the client for dispatcher review.
    // The flag (not the balance) is the only client write at creation — the balance
    // is committed on acceptance (deferred commit, PRODUCT.md). Cleared by acceptOrder.
    if (claimedOnHand != null) {
      await this.clients.setTaraState(clientId, { pendingReview: true });
    }

    await this.dispatcher.notifyNewOrder(order, client, address);

    return order;
  }

  /**
   * The client asked the dispatcher to call back for a non-standard onboarding case
   * ("Other"): no order is created — just notify the dispatcher (STEP3 T4). Errors
   * propagate so the caller can react (the client already has the support phone).
   */
  async requestCallback(clientId: string): Promise<void> {
    const client = await this.clients.getById(clientId);
    if (!client) {
      throw new Error(`client not found: ${clientId}`);
    }
    await this.dispatcher.notifyCallbackRequest(client);
  }

  /**
   * Computes the price preview for the confirmation screen (SPEC §6) without
   * creating an order. Uses the same pricing/pricing-settings as createOrder — a
   * single source of truth for the total (CLAUDE.md §1). perBottle is derived from
   * totalPrice so as not to duplicate the price-branch choice from PricingService.
   */
  async quote(
    clientId: string,
    bottles: number,
    opts: PumpOptions = {},
  ): Promise<OrderQuote> {
    const client = await this.clients.getById(clientId);
    // Normalize identically to createOrder so the preview can never diverge from the
    // charged total (0/negative claim → undefined, i.e. "no bottles").
    const claimedOnHand = this.normalizeClaim(opts.claimedOnHand);
    const kind = client
      ? await this.deriveKind(client, claimedOnHand)
      : OrderKind.STARTER_KIT;
    // Mirror createOrder: an OWN_TARA claim is not committed yet, so quote off the
    // self-declared count; otherwise off the client's balance.
    const bottlesOnHand = claimedOnHand ?? client?.bottlesOnHand ?? 0;
    const prices = await this.pricingSettings.getCurrent();
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      kind,
      prices,
      bottlesOnHand,
      opts,
    );
    const newTara = this.pricing.newTara(bottles, kind, bottlesOnHand);
    return {
      kind,
      bottles,
      totalPrice,
      perBottle:
        kind === OrderKind.STARTER_KIT
          ? null
          : this.pricing.waterUnitPrice(bottles, prices),
      newTara,
      depositPerBottle: prices.depositPerBottle,
      pumpPrice: prices.pumpPrice,
      electroPumpPrice: prices.electroPumpPrice,
      waterStartPrice: prices.waterStartPrice,
      electro: opts.electro ?? false,
      pumpAddon: opts.pumpAddon ?? false,
    };
  }

  /**
   * Editing the bottle quantity in an active order by the dispatcher (SPEC §7, the
   * "✏️ Edit" button): recomputes totalPrice via pricing (by the order's kind and
   * current prices). This is a deliberate manual override — the price freeze at
   * creation (§4) protects against AUTO-recompute on a price change, not against a
   * dispatcher edit. Allowed only for created/accepted.
   */
  async editQuantity(
    orderId: string,
    bottles: number,
  ): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new Error(`cannot edit order ${orderId} in status ${order.status}`);
    }
    const prices = await this.pricingSettings.getCurrent();
    const client = await this.clients.getById(order.clientId);
    const bottlesOnHand = client?.bottlesOnHand ?? 0;
    const totalPrice = this.pricing.calculateTotal(
      bottles,
      order.kind,
      prices,
      bottlesOnHand,
      { electro: order.electro, pumpAddon: order.pumpAddon },
    );
    // Editing is allowed only before delivery, so bottlesOnHand is still the
    // pre-delivery value — re-snapshot newTara for the new quantity.
    const newTara = this.pricing.newTara(bottles, order.kind, bottlesOnHand);
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { bottles, newTara, totalPrice },
      include: { client: true, address: true },
    });
    this.emitEdited(updated);
    return updated;
  }

  /**
   * Dispatcher edit of the delivery address TEXT of an active order (✏️ → 📍 Адресу).
   * The text is stored on the shared Address (reused across the client's orders, like
   * geo-tagging) — a typo fix propagates to the client's future orders too, which is
   * the intended behaviour. Allowed only for created/accepted. Notifies the client.
   */
  async editOrderAddress(
    orderId: string,
    raw: string,
  ): Promise<OrderWithRelations> {
    const order = await this.requireEditableOrder(orderId);
    await this.prisma.address.update({
      where: { id: order.addressId },
      data: { raw },
    });
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { client: true, address: true },
    });
    this.emitEdited(updated);
    return updated;
  }

  /**
   * Dispatcher edit of the address COMMENT of an active order (✏️ → 📝 Коментар).
   * Stored on the shared Address like {@link editOrderAddress}. Allowed only for
   * created/accepted. Notifies the client.
   */
  async editOrderComment(
    orderId: string,
    comment: string,
  ): Promise<OrderWithRelations> {
    const order = await this.requireEditableOrder(orderId);
    await this.prisma.address.update({
      where: { id: order.addressId },
      data: { comment },
    });
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { client: true, address: true },
    });
    this.emitEdited(updated);
    return updated;
  }

  /**
   * Dispatcher sets/updates the delivery-timing message shown to the client (🕒):
   * "сьогодні", "перенесено на завтра", "протягом години", … Stored on the order
   * (last message wins) and pushed to the client via the delivery-note event. Allowed
   * only while the order is active (created/accepted) — a delivered/cancelled order has
   * no pending delivery to reschedule.
   */
  async setDeliveryNote(
    orderId: string,
    deliveryNote: string,
  ): Promise<OrderWithRelations> {
    await this.requireEditableOrder(orderId);
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { deliveryNote },
      include: { client: true, address: true },
    });
    this.emitDeliveryNote(updated);
    return updated;
  }

  /**
   * Loads an order and asserts it is still editable by the dispatcher (created/
   * accepted — not delivered/cancelled). Shared guard for the content-edit methods.
   */
  private async requireEditableOrder(orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new Error(`cannot edit order ${orderId} in status ${order.status}`);
    }
    return order;
  }

  /**
   * Attaches delivery coordinates to an order's address (dispatcher geo-tagging, for
   * future route optimization). The client enters the address as free text; the
   * dispatcher pins the point on demand. Stored on the Address (reused across the
   * client's orders), not on the Order. Returns the order view to redraw the card.
   */
  async setOrderAddressGeo(
    orderId: string,
    lat: number,
    lng: number,
  ): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    await this.prisma.address.update({
      where: { id: order.addressId },
      data: { lat, lng },
    });
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { client: true, address: true },
    });
  }

  /**
   * Dispatcher correction of the self-declared bottle balance on a flagged OWN_TARA
   * order BEFORE acceptance (step B). The OWN_TARA total is independent of the count
   * (water by grid + optional pump, deposit 0), so `totalPrice`/`newTara` are NOT
   * recomputed — only the claim is fixed. Its purpose is the balance committed to the
   * client on accept: an inflated claim would otherwise leak into future REPEAT
   * tara-top-up math. Allowed only while CREATED (the balance is not committed yet)
   * and only for an OWN_TARA order carrying a claim.
   */
  async editClaimedOnHand(
    orderId: string,
    claimedOnHand: number,
  ): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (order.status !== OrderStatus.CREATED) {
      throw new Error(
        `cannot edit the claim of order ${orderId} in status ${order.status}`,
      );
    }
    if (order.kind !== OrderKind.OWN_TARA || order.claimedOnHand == null) {
      throw new Error(`order ${orderId} has no self-declared balance to edit`);
    }
    return this.prisma.order.update({
      where: { id: orderId },
      data: { claimedOnHand },
      include: { client: true, address: true },
    });
  }

  /**
   * CREATED → ACCEPTED. Acceptance IS the verification of a self-declared OWN_TARA
   * claim: commit the claimed balance to the client and clear `pendingReview`
   * (deferred commit — PRODUCT.md). A pump the client already owns (OWN_TARA without
   * an add-on) is recorded here too; an add-on pump is credited on delivery instead.
   */
  async acceptOrder(id: string): Promise<Order> {
    const order = await this.transition(
      id,
      OrderStatus.CREATED,
      OrderStatus.ACCEPTED,
      { acceptedAt: new Date() },
    );
    const data: {
      pendingReview: boolean;
      bottlesOnHand?: number;
      hasPump?: boolean;
    } = { pendingReview: false };
    if (order.claimedOnHand != null) {
      // A claim is a TOTAL balance, committed only when there is nothing to overwrite.
      // The onboarding gate ensures this runs only on a first order (empty balance);
      // guard it here too so a stale claim can never silently wipe a real balance.
      const client = await this.clients.getById(order.clientId);
      if ((client?.bottlesOnHand ?? 0) === 0) {
        // Verified self-declared balance — commit it now (deferred at creation).
        data.bottlesOnHand = order.claimedOnHand;
        // Client owns a pump unless they asked us to add one (credited on delivery).
        if (!order.pumpAddon) data.hasPump = true;
      } else {
        this.logger.warn(
          `acceptOrder ${id}: skipping claim commit — client ${order.clientId} ` +
            `already has bottlesOnHand=${client?.bottlesOnHand}`,
        );
      }
    }
    await this.clients.setTaraState(order.clientId, data);
    this.emitStatusChanged(order);
    return order;
  }

  /** ACCEPTED → DELIVERED. Delivery credits new tara to the client (PRODUCT.md). */
  async markDelivered(id: string): Promise<Order> {
    const order = await this.transition(
      id,
      OrderStatus.ACCEPTED,
      OrderStatus.DELIVERED,
      { deliveredAt: new Date() },
    );
    await this.creditTara(order);
    this.emitStatusChanged(order);
    return order;
  }

  /**
   * Credits new bottles into circulation to the client on delivery (PRODUCT.md,
   * decision #1): STARTER_KIT — all bottles of the order, REPEAT — the top-up above
   * the remainder, OWN_TARA — zero. Best-effort: a balance-accounting failure must
   * not break an already-completed delivery.
   */
  private async creditTara(order: Order): Promise<void> {
    try {
      // Use the snapshot taken at order time — recomputing from the current
      // bottlesOnHand would drift if other orders were delivered in between.
      const newTara = order.newTara;
      const data: { bottlesOnHand?: { increment: number }; hasPump?: boolean } =
        {};
      if (newTara > 0) data.bottlesOnHand = { increment: newTara };
      // The starter kit includes a pump, and an OWN_TARA add-on pump is delivered now —
      // record the pump for the client on delivery in both cases.
      if (order.kind === OrderKind.STARTER_KIT || order.pumpAddon) {
        data.hasPump = true;
      }
      if (Object.keys(data).length === 0) return;
      await this.prisma.client.update({
        where: { id: order.clientId },
        data,
      });
    } catch (err) {
      this.logger.error(
        `creditTara failed for order ${order.id}: ${(err as Error).message}`,
      );
    }
  }

  /** CREATED/ACCEPTED → CANCELLED. A delivered or already cancelled one — not allowed. */
  async cancelOrder(id: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id } });
    if (
      order.status !== OrderStatus.CREATED &&
      order.status !== OrderStatus.ACCEPTED
    ) {
      throw new Error(`cannot cancel order ${id} in status ${order.status}`);
    }
    const cancelled = await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED },
    });
    this.emitStatusChanged(cancelled);
    return cancelled;
  }

  /**
   * CANCELLED → CREATED: undo a just-made dispatcher cancellation (mis-tap safety net,
   * PRODUCT.md). Works ONLY while the order is still CANCELLED — an atomic guarded
   * update (where includes status), like {@link cancelOrder}/{@link acceptOrder}, so a
   * double undo or a race can't resurrect an order twice. Reverts to CREATED (the
   * pre-accept active state); the dispatcher re-accepts if needed. No client push: a
   * cancel-then-undo is a dispatcher correction the client should not see flip-flop.
   */
  async revertCancellation(id: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id } });
    if (order.status !== OrderStatus.CANCELLED) {
      throw new Error(`cannot revert order ${id} in status ${order.status}`);
    }
    return this.prisma.order.update({
      where: { id, status: OrderStatus.CANCELLED },
      data: { status: OrderStatus.CREATED },
    });
  }

  /**
   * Notifies subscribers about an order status change by the dispatcher (the client
   * bot will notify the client, SPEC §8). Only for dispatcher transitions —
   * cancellation by the client (cancelOwnOrder) is NOT routed here.
   */
  private emitStatusChanged(order: Order): void {
    const payload: OrderStatusChangedEvent = { order };
    this.events.emit(ORDER_STATUS_CHANGED, payload);
  }

  /**
   * Notifies subscribers that the dispatcher edited an order's content (quantity /
   * address / comment) — the client bot tells the client. Fire-and-forget, like
   * {@link emitStatusChanged}: the listener swallows its own errors.
   */
  private emitEdited(order: Order): void {
    const payload: OrderEditedEvent = { order };
    this.events.emit(ORDER_EDITED, payload);
  }

  /**
   * Notifies subscribers that the dispatcher set a delivery-timing message for the
   * client — the client bot pushes it. Fire-and-forget, like the other order events.
   */
  private emitDeliveryNote(order: Order): void {
    const payload: OrderDeliveryNoteEvent = { order };
    this.events.emit(ORDER_DELIVERY_NOTE, payload);
  }

  /**
   * Cancellation of an order by the client themselves from the bot (SPEC §9).
   * Allowed only while the dispatcher has not accepted (CREATED status) and only for
   * their own order (owner check by clientId — a callback can be forged, CLAUDE.md
   * rule 8). After cancellation we notify the dispatcher best-effort: its failure
   * does not undo the cancellation (rule 9 — for the client it already happened).
   */
  async cancelOwnOrder(orderId: string, clientId: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (order.clientId !== clientId) {
      throw new Error(`order ${orderId} does not belong to client ${clientId}`);
    }
    if (order.status !== OrderStatus.CREATED) {
      throw new Error(
        `client cannot cancel order ${orderId} in status ${order.status}`,
      );
    }
    // where includes status — an atomic guard against a race with dispatcher accept.
    const cancelled = await this.prisma.order.update({
      where: { id: orderId, status: OrderStatus.CREATED },
      data: { status: OrderStatus.CANCELLED },
    });

    const client = await this.clients.getById(clientId);
    if (client) {
      try {
        await this.dispatcher.notifyClientCancelled(cancelled, client);
      } catch (err) {
        this.logger.error(
          `notifyClientCancelled failed for order ${orderId}: ${(err as Error).message}`,
        );
      }
    }
    return cancelled;
  }

  /**
   * First order = the client has no order with a status other than CANCELLED
   * (SPEC §5). Cancelled orders "don't count".
   */
  private async isFirstOrder(clientId: string): Promise<boolean> {
    const activeCount = await this.prisma.order.count({
      where: { clientId, status: { not: OrderStatus.CANCELLED } },
    });
    return activeCount === 0;
  }

  /**
   * Normalizes a self-declared bottle claim: only a positive count is a real OWN_TARA
   * declaration; 0/negative/undefined all mean "no bottles" → undefined. Single source
   * of truth shared by quote() and createOrder() so the preview and the charged total
   * derive the kind and tara math from identical inputs (no divergence on edge values).
   */
  private normalizeClaim(claimedOnHand?: number): number | undefined {
    return claimedOnHand != null && claimedOnHand > 0
      ? claimedOnHand
      : undefined;
  }

  /**
   * Order kind by the client's state: has past orders → REPEAT; a first order with
   * own bottles → OWN_TARA; otherwise → STARTER_KIT. "Own bottles" on a first order
   * is the self-declared `claimedOnHand` from onboarding (not yet committed to the
   * client, deferred commit) — with a fallback to a committed `bottlesOnHand` for a
   * client whose balance is already known.
   */
  private async deriveKind(
    client: Client,
    claimedOnHand?: number,
  ): Promise<OrderKind> {
    if (!(await this.isFirstOrder(client.id))) return OrderKind.REPEAT;
    return (claimedOnHand ?? 0) > 0 || client.bottlesOnHand > 0
      ? OrderKind.OWN_TARA
      : OrderKind.STARTER_KIT;
  }

  /** Status change with a validity check of the from → to transition. */
  private async transition(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    extra: { acceptedAt?: Date; deliveredAt?: Date } = {},
  ): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id } });
    if (order.status !== from) {
      throw new Error(
        `invalid transition for order ${id}: ${order.status} → ${to} (expected from ${from})`,
      );
    }
    return this.prisma.order.update({
      where: { id, status: from },
      data: { status: to, ...extra },
    });
  }
}
