import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import { DEMO_SHOWCASE_PHONE_PREFIX } from '../../config/demo';
import { OrderKind, OrderStatus } from '../../../generated/prisma/enums';

/** One fake order of the showcase history. */
interface ShowcaseOrderSpec {
  bottles: number;
  kind: OrderKind;
  status: OrderStatus;
  /** How long ago it was placed — everything else is derived from this. */
  hoursAgo: number;
  note?: string;
  deliveryNote?: string;
  cancelReason?: string;
}

/** One fake client of the showcase history, with their address and orders. */
interface ShowcaseClientSpec {
  name: string;
  bottlesOnHand: number;
  hasPump: boolean;
  address: string;
  comment?: string;
  orders: ShowcaseOrderSpec[];
}

/**
 * The fake history a buyer sees on their FIRST look at the dispatcher side: a queue
 * with something in it, a week of deliveries in /stats, clients to look up by phone.
 * An empty stand demos nothing. Deliberately small — a plausible day, not a data dump.
 */
const SHOWCASE: readonly ShowcaseClientSpec[] = [
  {
    name: 'Олена Ковальчук',
    bottlesOnHand: 3,
    hasPump: true,
    address: 'вул. Гагаріна, 12, кв. 5',
    comment: '2 під’їзд, код 45',
    orders: [
      {
        bottles: 3,
        kind: OrderKind.REPEAT,
        status: OrderStatus.DELIVERED,
        hoursAgo: 50,
      },
      {
        bottles: 2,
        kind: OrderKind.REPEAT,
        status: OrderStatus.DELIVERED,
        hoursAgo: 26,
      },
      {
        bottles: 2,
        kind: OrderKind.REPEAT,
        status: OrderStatus.CREATED,
        hoursAgo: 1,
        note: 'Подзвоніть за 10 хвилин до приїзду',
      },
    ],
  },
  {
    name: 'Ігор Сергієнко',
    bottlesOnHand: 6,
    hasPump: true,
    address: 'вул. Соборна, 8, офіс 3',
    comment: 'Бізнес-центр, 4 поверх',
    orders: [
      {
        bottles: 6,
        kind: OrderKind.REPEAT,
        status: OrderStatus.DELIVERED,
        hoursAgo: 30,
      },
      {
        bottles: 4,
        kind: OrderKind.REPEAT,
        status: OrderStatus.ACCEPTED,
        hoursAgo: 3,
        deliveryNote: 'сьогодні до 18:00',
      },
    ],
  },
  {
    name: 'Марина Литвин',
    bottlesOnHand: 2,
    hasPump: true,
    address: 'вул. Лесі Українки, 44, кв. 17',
    orders: [
      {
        bottles: 2,
        kind: OrderKind.STARTER_KIT,
        status: OrderStatus.DELIVERED,
        hoursAgo: 5,
      },
      {
        bottles: 1,
        kind: OrderKind.REPEAT,
        status: OrderStatus.CANCELLED,
        hoursAgo: 20,
        cancelReason: 'Клієнт передумав',
      },
    ],
  },
];

const HOUR_MS = 60 * 60 * 1000;

/**
 * Seeds (once) the demo stand's showcase history. Runs inside the app instead of a
 * `prisma db seed` script on purpose: the production image ships without dev
 * dependencies, so `tsx prisma/seed.*.ts` cannot run on the stand's server at all.
 *
 * Idempotent: it does nothing when showcase clients already exist, so restarts and the
 * hourly sweep are both safe. Showcase rows carry their own phone prefix
 * ({@link DEMO_SHOWCASE_PHONE_PREFIX}) — that is what keeps the sweep, which deletes
 * only visitor rows, from ever touching them.
 *
 * Money comes from PricingService like everywhere else (CLAUDE.md rule 1) — the
 * showcase must not invent its own totals.
 */
@Injectable()
export class DemoShowcaseService implements OnModuleInit {
  private readonly logger = new Logger(DemoShowcaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly pricingSettings: PricingSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensure();
    } catch (err) {
      // A stand that cannot seed its showcase still works — it just looks empty.
      this.logger.warn(
        `demo showcase seeding failed: ${(err as Error).message}`,
      );
    }
  }

  /** Creates the showcase unless it is already there. Safe to call repeatedly. */
  async ensure(): Promise<void> {
    const existing = await this.prisma.client.count({
      where: { phone: { startsWith: DEMO_SHOWCASE_PHONE_PREFIX } },
    });
    if (existing > 0) return;

    // A brand-new stand may not have the PriceSettings row yet (no seed step in the
    // demo compose) — this both creates it and pins the showcase to known prices.
    const prices = await this.pricingSettings.resetToDefaults();
    const now = Date.now();

    for (const [index, spec] of SHOWCASE.entries()) {
      const client = await this.prisma.client.create({
        data: {
          // Fake ids far outside the Telegram range: nobody can ever log in as them.
          telegramId: BigInt(-(index + 1)),
          phone: `${DEMO_SHOWCASE_PHONE_PREFIX}${String(index + 1).padStart(9, '0')}`,
          name: spec.name,
          bottlesOnHand: spec.bottlesOnHand,
          hasPump: spec.hasPump,
        },
      });
      const address = await this.prisma.address.create({
        data: {
          clientId: client.id,
          raw: spec.address,
          comment: spec.comment ?? null,
          isDefault: true,
        },
      });

      for (const order of spec.orders) {
        const createdAt = new Date(now - order.hoursAgo * HOUR_MS);
        const newTara = this.pricing.newTara(
          order.bottles,
          order.kind,
          spec.bottlesOnHand,
        );
        await this.prisma.order.create({
          data: {
            clientId: client.id,
            addressId: address.id,
            bottles: order.bottles,
            kind: order.kind,
            newTara,
            totalPrice: this.pricing.calculateTotal(
              order.bottles,
              order.kind,
              prices,
              spec.bottlesOnHand,
            ),
            status: order.status,
            note: order.note ?? null,
            deliveryNote: order.deliveryNote ?? null,
            cancelReason: order.cancelReason ?? null,
            createdAt,
            acceptedAt: this.acceptedAt(order, createdAt),
            deliveredAt:
              order.status === OrderStatus.DELIVERED
                ? new Date(createdAt.getTime() + 3 * HOUR_MS)
                : null,
          },
        });
      }
    }

    this.logger.log(`demo showcase seeded: ${SHOWCASE.length} clients`);
  }

  /** Accepted 15 minutes after ordering — for anything that got past CREATED. */
  private acceptedAt(order: ShowcaseOrderSpec, createdAt: Date): Date | null {
    const accepted =
      order.status === OrderStatus.ACCEPTED ||
      order.status === OrderStatus.DELIVERED;
    return accepted ? new Date(createdAt.getTime() + 15 * 60 * 1000) : null;
  }
}
