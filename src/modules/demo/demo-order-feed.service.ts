import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { DispatchersService } from '../dispatchers/dispatchers.service';
import {
  DEMO_SHOWCASE_PHONE_PREFIX,
  DEMO_VISITOR_DISPATCHER_LABEL,
  DEMO_VISITOR_DISPATCHER_TTL_MS,
  demoOrderFeedIntervalMs,
} from '../../config/demo';
import { pickFeedOrder } from './demo.fsm';
import { OrderStatus } from '../../../generated/prisma/enums';

/**
 * How many active orders (CREATED + ACCEPTED) are enough — above that the feed keeps
 * quiet. Normally the simulated dispatcher drains the queue in about a minute, so this
 * only matters when its delays are set long or a buyer is sitting on the cards.
 */
const MAX_ACTIVE_ORDERS = 6;

/**
 * How many showcase orders are kept. The seeded history plus a couple of hours of feed;
 * everything older is dropped so /stats keeps reading like a real week instead of
 * growing into thousands of deliveries on a stand nobody restarts.
 */
const KEEP_SHOWCASE_ORDERS = 25;

/**
 * Makes the dispatcher side of the stand look alive: every few minutes a showcase client
 * "places" an order, so a buyer watching the operator bot sees cards arrive, statuses
 * move and the queue breathe — instead of a static list seeded once at boot.
 *
 * The order is created through OrdersService like any other (CLAUDE.md rule 1 and 4):
 * same pricing, same broadcast to the dispatcher chats, same ORDER_CREATED event that
 * the simulated dispatcher listens to. Nothing here knows about Telegram.
 *
 * It only runs while a visitor is actually subscribed to the dispatcher bot (the rows
 * carrying {@link DEMO_VISITOR_DISPATCHER_LABEL}) — an unwatched stand invents nothing,
 * so the super-admin's chat stays quiet around the clock.
 *
 * The service also does its own housekeeping on each tick, because both chores are
 * bounded by the feed and not by the visitor sweep: it prunes old showcase orders, and
 * it un-registers demo visitors whose short dispatcher lease
 * ({@link DEMO_VISITOR_DISPATCHER_TTL_MS}) has run out — a buyer who left must stop
 * receiving cards within minutes, not at the next hourly sweep.
 */
@Injectable()
export class DemoOrderFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoOrderFeedService.name);
  private timer?: NodeJS.Timeout;
  /** Tick counter — the pure picker turns it into "who orders what" (demo.fsm). */
  private seq = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly dispatchers: DispatchersService,
  ) {}

  onModuleInit(): void {
    const intervalMs = demoOrderFeedIntervalMs(process.env);
    if (intervalMs === 0) {
      this.logger.log('demo order feed disabled (DEMO_ORDER_INTERVAL_MIN=0)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Never keep the process alive just to invent another order.
    this.timer.unref();
    this.logger.log(
      `demo order feed every ${Math.round(intervalMs / 60000)} min`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass: expire idle visitors, trim history, then place an order unless the queue
   * is already busy. Swallows its own errors — background housekeeping must never take
   * the stand down (same contract as the cleanup sweep and the event listeners).
   */
  async tick(): Promise<void> {
    try {
      await this.expireVisitorDispatchers();
      await this.pruneShowcaseOrders();

      // Nobody is looking at the dispatcher side → invent nothing. Otherwise the stand
      // would card-bomb the super-admin's chat every few minutes around the clock and
      // grow the database for an audience of zero. The feed exists for a watching
      // buyer, so it runs exactly while one is subscribed.
      const watching = await this.dispatchers.countAutoAdded(
        DEMO_VISITOR_DISPATCHER_LABEL,
      );
      if (watching === 0) return;

      const active = await this.prisma.order.count({
        where: {
          status: { in: [OrderStatus.CREATED, OrderStatus.ACCEPTED] },
        },
      });
      if (active >= MAX_ACTIVE_ORDERS) return;

      const clients = await this.prisma.client.findMany({
        where: { phone: { startsWith: DEMO_SHOWCASE_PHONE_PREFIX } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      const spec = pickFeedOrder(
        this.seq,
        clients.map((c) => c.id),
      );
      // No showcase yet (first boot, seeding still running) — try again next tick.
      if (!spec) return;
      this.seq += 1;

      const order = await this.orders.createOrder(spec.clientId, spec.bottles);
      this.logger.log(
        `demo feed: order ${order.id} (${spec.bottles} bottles) placed`,
      );
    } catch (err) {
      this.logger.warn(`demo order feed failed: ${(err as Error).message}`);
    }
  }

  /**
   * Drops the auto-created dispatcher rows of visitors whose lease expired. Matched by
   * the demo label AND the age — a dispatcher the super-admin added by hand carries a
   * different label and is never touched.
   */
  private async expireVisitorDispatchers(): Promise<void> {
    const removed = await this.dispatchers.deleteAutoAdded(
      DEMO_VISITOR_DISPATCHER_LABEL,
      new Date(Date.now() - DEMO_VISITOR_DISPATCHER_TTL_MS),
    );
    if (removed > 0) {
      this.logger.log(`demo feed: ${removed} idle visitor(s) unsubscribed`);
    }
  }

  /**
   * Keeps only the newest {@link KEEP_SHOWCASE_ORDERS} showcase orders. Visitors' own
   * orders are untouched — they belong to the visitor sweep with its own TTL.
   */
  private async pruneShowcaseOrders(): Promise<void> {
    const stale = await this.prisma.order.findMany({
      where: {
        client: { phone: { startsWith: DEMO_SHOWCASE_PHONE_PREFIX } },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      skip: KEEP_SHOWCASE_ORDERS,
    });
    if (stale.length === 0) return;
    const { count } = await this.prisma.order.deleteMany({
      where: { id: { in: stale.map((o) => o.id) } },
    });
    this.logger.debug(`demo feed: pruned ${count} old showcase order(s)`);
  }
}
