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
  type OrderStatusChangedEvent,
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

  /** Order with client and address — for redrawing the dispatcher's message (SPEC §7). */
  getOrderView(id: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { id },
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
   * Summary for /stats (SPEC §7): order count and total for today and the last 7
   * days, without cancelled. "Today" — from local midnight, "week" — a rolling
   * 7 days. Full analytics — a separate module later.
   */
  async stats(): Promise<{
    today: { count: number; sum: number };
    week: { count: number; sum: number };
  }> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const notCancelled = { status: { not: OrderStatus.CANCELLED } };
    const todayWhere = { ...notCancelled, createdAt: { gte: startOfToday } };
    const weekWhere = { ...notCancelled, createdAt: { gte: weekAgo } };

    const [todayCount, todayAgg, weekCount, weekAgg] =
      await this.prisma.$transaction([
        this.prisma.order.count({ where: todayWhere }),
        this.prisma.order.aggregate({
          where: todayWhere,
          _sum: { totalPrice: true },
        }),
        this.prisma.order.count({ where: weekWhere }),
        this.prisma.order.aggregate({
          where: weekWhere,
          _sum: { totalPrice: true },
        }),
      ]);
    return {
      today: { count: todayCount, sum: todayAgg._sum.totalPrice ?? 0 },
      week: { count: weekCount, sum: weekAgg._sum.totalPrice ?? 0 },
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
    const claimedOnHand =
      opts.claimedOnHand != null && opts.claimedOnHand > 0
        ? opts.claimedOnHand
        : undefined;
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
    const kind = client
      ? await this.deriveKind(client, opts.claimedOnHand)
      : OrderKind.STARTER_KIT;
    // Mirror createOrder: an OWN_TARA claim is not committed yet, so quote off the
    // self-declared count; otherwise off the client's balance.
    const bottlesOnHand = opts.claimedOnHand ?? client?.bottlesOnHand ?? 0;
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
    return this.prisma.order.update({
      where: { id: orderId },
      data: { bottles, newTara, totalPrice },
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
   * Notifies subscribers about an order status change by the dispatcher (the client
   * bot will notify the client, SPEC §8). Only for dispatcher transitions —
   * cancellation by the client (cancelOwnOrder) is NOT routed here.
   */
  private emitStatusChanged(order: Order): void {
    const payload: OrderStatusChangedEvent = { order };
    this.events.emit(ORDER_STATUS_CHANGED, payload);
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
