import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ClientsService } from '../clients/clients.service';
import type { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import { PricingService } from '../pricing/pricing.service';
import { OrdersService } from './orders.service';

// PrismaService pulls the generated Prisma 7 client (ESM, import.meta), which
// ts-jest does not compile under CommonJS. The client is not needed in the unit test — mock the module.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

const prices = {
  id: 1,
  price1: 80,
  priceFrom2: 70,
  priceFrom6: 65,
  depositPerBottle: 450,
  pumpPrice: 250,
  electroPumpPrice: 270,
  waterStartPrice: 50,
  updatedAt: new Date('2026-05-30T00:00:00.000Z'),
};

const client = {
  id: 'c1',
  telegramId: 1n,
  phone: '+380',
  name: null,
  createdAt: new Date(),
  bottlesOnHand: 5,
  hasPump: true,
};

const address = {
  id: 'a1',
  clientId: 'c1',
  raw: 'St. 1',
  comment: null,
  isDefault: true,
  createdAt: new Date(),
};

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: {
    order: {
      create: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    client: { update: jest.Mock };
  };
  let clients: {
    getById: jest.Mock;
    getDefaultAddress: jest.Mock;
    setTaraState: jest.Mock;
  };
  let pricingSettings: { getCurrent: jest.Mock };
  let dispatcher: {
    notifyNewOrder: jest.Mock;
    notifyClientCancelled: jest.Mock;
    notifyCallbackRequest: jest.Mock;
  };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    prisma = {
      order: {
        create: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      client: { update: jest.fn() },
    };
    clients = {
      getById: jest.fn().mockResolvedValue(client),
      getDefaultAddress: jest.fn().mockResolvedValue(address),
      setTaraState: jest.fn().mockResolvedValue(undefined),
    };
    pricingSettings = { getCurrent: jest.fn().mockResolvedValue(prices) };
    dispatcher = {
      notifyNewOrder: jest.fn().mockResolvedValue(undefined),
      notifyClientCancelled: jest.fn().mockResolvedValue(undefined),
      notifyCallbackRequest: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      clients as unknown as ClientsService,
      new PricingService(),
      pricingSettings as unknown as PricingSettingsService,
      // mock is structurally compatible with OrderDispatcher (notifyNewOrder/notifyClientCancelled).
      dispatcher,
      events as unknown as EventEmitter2,
    );
  });

  // Checks go through the typed mocks prisma.order.* / dispatcher.notifyNewOrder:
  // the Order returned by the service comes from the generated client and in the
  // unit-test context is inferred as any, so the assertions are built on call arguments.
  describe('createOrder', () => {
    it('first order: kind=STARTER_KIT, total by the starter kit (1 bottle → 750)', async () => {
      // New client without own bottles → STARTER_KIT (deriveKind looks at bottlesOnHand).
      const freshClient = { ...client, bottlesOnHand: 0 };
      clients.getById.mockResolvedValue(freshClient);
      const created = { id: 'o1', kind: 'STARTER_KIT', totalPrice: 750 };
      prisma.order.count.mockResolvedValue(0);
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 1);

      expect(prisma.order.count).toHaveBeenCalledWith({
        where: { clientId: 'c1', status: { not: 'CANCELLED' } },
      });
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 1,
          kind: 'STARTER_KIT',
          newTara: 1,
          electro: false,
          pumpAddon: false,
          claimedOnHand: null,
          totalPrice: 750,
          status: 'CREATED',
        },
      });
      expect(dispatcher.notifyNewOrder).toHaveBeenCalledWith(
        created,
        freshClient,
        address,
      );
    });

    it('repeat order: kind=REPEAT, total by the water grid (2 bottles → 140)', async () => {
      const created = { id: 'o2', kind: 'REPEAT', totalPrice: 140 };
      prisma.order.count.mockResolvedValue(3); // there are past active orders
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          kind: 'REPEAT',
          newTara: 0,
          electro: false,
          pumpAddon: false,
          claimedOnHand: null,
          totalPrice: 140,
          status: 'CREATED',
        },
      });
    });

    it('first order with own bottles (bottlesOnHand>0) → kind=OWN_TARA, water only (2 → 140)', async () => {
      // shared client: bottlesOnHand=5 → the first order is recognised as own bottles.
      const created = { id: 'o3', kind: 'OWN_TARA', totalPrice: 140 };
      prisma.order.count.mockResolvedValue(0); // first order
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          kind: 'OWN_TARA',
          newTara: 0,
          electro: false,
          pumpAddon: false,
          claimedOnHand: null,
          totalPrice: 140,
          status: 'CREATED',
        },
      });
    });

    it('first order with a self-declared claim (deferred commit) → OWN_TARA, stores claimedOnHand, flags pendingReview but does NOT commit the balance', async () => {
      // Fresh client (balance 0): the claim, not the committed balance, drives OWN_TARA.
      const freshClient = { ...client, bottlesOnHand: 0, hasPump: false };
      clients.getById.mockResolvedValue(freshClient);
      const created = { id: 'o4', kind: 'OWN_TARA', totalPrice: 140 };
      prisma.order.count.mockResolvedValue(0); // first order
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2, { claimedOnHand: 3 });

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          kind: 'OWN_TARA',
          newTara: 0,
          electro: false,
          pumpAddon: false,
          claimedOnHand: 3,
          totalPrice: 140,
          status: 'CREATED',
        },
      });
      // Only the review flag is written at creation — the balance is committed on accept.
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: true,
      });
      expect(clients.setTaraState).not.toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ bottlesOnHand: expect.anything() as number }),
      );
    });

    it('throws if the client has no default address, and the order is not created', async () => {
      clients.getDefaultAddress.mockResolvedValue(null);
      prisma.order.count.mockResolvedValue(0);

      await expect(service.createOrder('c1', 1)).rejects.toThrow();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('requestCallback', () => {
    it('notifies the dispatcher with the client, without creating an order', async () => {
      await service.requestCallback('c1');

      expect(dispatcher.notifyCallbackRequest).toHaveBeenCalledWith(client);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('throws if the client is not found', async () => {
      clients.getById.mockResolvedValue(null);

      await expect(service.requestCallback('c1')).rejects.toThrow();
      expect(dispatcher.notifyCallbackRequest).not.toHaveBeenCalled();
    });
  });

  describe('lastBottles', () => {
    it('returns the bottles of the last non-cancelled order', async () => {
      prisma.order.findFirst.mockResolvedValue({ bottles: 3 });

      const result = await service.lastBottles('c1');

      expect(result).toBe(3);
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { bottles: true },
      });
    });

    it('returns null if there is nothing to repeat', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.lastBottles('c1')).resolves.toBeNull();
    });
  });

  describe('status transitions', () => {
    it('acceptOrder: CREATED → ACCEPTED + clears the client pendingReview', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'ACCEPTED',
      });

      await service.acceptOrder('o1');

      // accepting = the dispatcher verifying the self-claimed existing client (T4).
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: false,
      });

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // where includes status: from — an atomic transition guard (see transition).
          where: { id: 'o1', status: 'CREATED' },
          // as object: expect.objectContaining() is typed as any (jest),
          // the cast removes no-unsafe-assignment when nested in a literal.
          data: expect.objectContaining({ status: 'ACCEPTED' }) as object,
        }),
      );
      // a dispatcher transition emits an event — the client bot notifies the client.
      expect(events.emit).toHaveBeenCalledWith('order.status.changed', {
        order: { id: 'o1', clientId: 'c1', status: 'ACCEPTED' },
      });
    });

    it('acceptOrder with a self-declared claim commits the balance + pump and clears pendingReview', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'ACCEPTED',
        claimedOnHand: 4,
        pumpAddon: false,
      });

      await service.acceptOrder('o1');

      // Verification = acceptance: the deferred balance is committed and the pump owned.
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: false,
        bottlesOnHand: 4,
        hasPump: true,
      });
    });

    it('acceptOrder with a claim + pump add-on commits the balance but defers hasPump to delivery', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'ACCEPTED',
        claimedOnHand: 4,
        pumpAddon: true,
      });

      await service.acceptOrder('o1');

      // Add-on pump is delivered later → hasPump is NOT set at acceptance.
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: false,
        bottlesOnHand: 4,
      });
    });

    it('markDelivered: ACCEPTED → DELIVERED credits new tara to the client (STARTER_KIT 2 → +2)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        kind: 'STARTER_KIT',
        bottles: 2,
        newTara: 2,
        status: 'DELIVERED',
      });

      await service.markDelivered('o1');

      // STARTER_KIT → all bottles into circulation + pump (kit) for the client.
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { bottlesOnHand: { increment: 2 }, hasPump: true },
      });
    });

    it('markDelivered: OWN_TARA with a pump add-on records the pump on delivery (no tara credit)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        kind: 'OWN_TARA',
        bottles: 2,
        newTara: 0,
        pumpAddon: true,
        status: 'DELIVERED',
      });

      await service.markDelivered('o1');

      // OWN_TARA newTara=0 → no balance increment; the add-on pump is recorded.
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { hasPump: true },
      });
    });

    it('markDelivered from CREATED (skipping ACCEPTED) throws', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });

      await expect(service.markDelivered('o1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('cancelOrder from DELIVERED throws', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'DELIVERED',
      });

      await expect(service.cancelOrder('o1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelOwnOrder (cancellation by the client)', () => {
    it('cancels their own CREATED order and notifies the dispatcher', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'CREATED',
      });
      const cancelled = { id: 'o1', clientId: 'c1', status: 'CANCELLED' };
      prisma.order.update.mockResolvedValue(cancelled);

      await service.cancelOwnOrder('o1', 'c1');

      expect(prisma.order.update).toHaveBeenCalledWith({
        // where includes status — an atomic guard against a race with accept.
        where: { id: 'o1', status: 'CREATED' },
        data: { status: 'CANCELLED' },
      });
      expect(dispatcher.notifyClientCancelled).toHaveBeenCalledWith(
        cancelled,
        client,
      );
      // a client self-cancellation is NOT pushed to the client (they initiated it) — no event emitted.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('cannot cancel a foreign order (wrong clientId)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'other-client',
        status: 'CREATED',
      });

      await expect(service.cancelOwnOrder('o1', 'c1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(dispatcher.notifyClientCancelled).not.toHaveBeenCalled();
    });

    it('the client cannot cancel an already accepted (ACCEPTED) order', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'ACCEPTED',
      });

      await expect(service.cancelOwnOrder('o1', 'c1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('a dispatcher notification failure does not break the cancellation', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      dispatcher.notifyClientCancelled.mockRejectedValue(new Error('tg down'));

      await expect(service.cancelOwnOrder('o1', 'c1')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
    });
  });

  describe('editQuantity (edit by the dispatcher)', () => {
    it('recomputes the total of a repeat order (3 bottles → 210) and updates', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'REPEAT',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', bottles: 3 });

      await service.editQuantity('o1', 3);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { bottles: 3, newTara: 0, totalPrice: 210 },
        include: { client: true, address: true },
      });
    });

    it('a first order is recomputed by the starter kit (2 → 1250)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
        kind: 'STARTER_KIT',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1' });

      await service.editQuantity('o1', 2);

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { bottles: 2, newTara: 2, totalPrice: 1250 },
        }),
      );
    });

    it('a delivered order cannot be changed', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'DELIVERED',
        kind: 'REPEAT',
      });

      await expect(service.editQuantity('o1', 3)).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('editClaimedOnHand (dispatcher correction of the declared balance, step B)', () => {
    it('updates claimedOnHand on a CREATED OWN_TARA order WITHOUT recomputing the total', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'OWN_TARA',
        claimedOnHand: 5,
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', claimedOnHand: 3 });

      await service.editClaimedOnHand('o1', 3);

      // Exact data match proves only the claim is touched — no totalPrice/newTara
      // recompute for OWN_TARA (the total is independent of the bottle count).
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { claimedOnHand: 3 },
        include: { client: true, address: true },
      });
    });

    it('rejects an order that is not OWN_TARA', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'REPEAT',
        claimedOnHand: null,
      });

      await expect(service.editClaimedOnHand('o1', 3)).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects an OWN_TARA order without a claim (claimedOnHand null)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'OWN_TARA',
        claimedOnHand: null,
      });

      await expect(service.editClaimedOnHand('o1', 3)).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects once the order is no longer CREATED (balance already committed)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
        kind: 'OWN_TARA',
        claimedOnHand: 5,
      });

      await expect(service.editClaimedOnHand('o1', 3)).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });
});
