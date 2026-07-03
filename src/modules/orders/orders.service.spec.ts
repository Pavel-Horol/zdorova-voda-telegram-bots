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
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      aggregate: jest.Mock;
    };
    client: { update: jest.Mock };
    address: { update: jest.Mock };
    $transaction: jest.Mock;
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
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
      },
      client: { update: jest.fn() },
      address: { update: jest.fn() },
      $transaction: jest.fn(),
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
          note: null,
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
          note: null,
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
          note: null,
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
          note: null,
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

    it('throws if the client is not found, and no order/notification happens', async () => {
      clients.getById.mockResolvedValue(null);

      await expect(service.createOrder('missing', 1)).rejects.toThrow(
        /client not found/,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(dispatcher.notifyNewOrder).not.toHaveBeenCalled();
    });

    it('a non-positive claimedOnHand (0) is treated as "no bottles": no review flag, no claim stored', async () => {
      // opts.claimedOnHand=0 means "starter kit", not an OWN_TARA declaration —
      // it must never flag pendingReview nor be persisted as a claim.
      const freshClient = { ...client, bottlesOnHand: 0, hasPump: false };
      clients.getById.mockResolvedValue(freshClient);
      prisma.order.count.mockResolvedValue(0);
      prisma.order.create.mockResolvedValue({ id: 'o5', kind: 'STARTER_KIT' });

      await service.createOrder('c1', 1, { claimedOnHand: 0 });

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'STARTER_KIT',
            claimedOnHand: null,
          }) as object,
        }),
      );
      expect(clients.setTaraState).not.toHaveBeenCalled();
    });

    it('stores the optional client note on the order', async () => {
      prisma.order.count.mockResolvedValue(3); // REPEAT
      prisma.order.create.mockResolvedValue({ id: 'o6' });

      await service.createOrder('c1', 2, {}, 'мене не буде з 14 до 16');

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            note: 'мене не буде з 14 до 16',
          }) as object,
        }),
      );
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
      // A claim is committed only on a first order (empty balance, see deferred commit).
      clients.getById.mockResolvedValue({ ...client, bottlesOnHand: 0 });
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
      clients.getById.mockResolvedValue({ ...client, bottlesOnHand: 0 });
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

    it('acceptOrder does NOT overwrite a non-empty balance with a stale claim (guard)', async () => {
      // Defensive: claim commit must never wipe a real balance (default client = 5).
      clients.getById.mockResolvedValue({ ...client, bottlesOnHand: 5 });
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

      // Only pendingReview is cleared — the balance is left untouched.
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: false,
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

    it('cancels even if the client record is gone, skipping the notification', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      clients.getById.mockResolvedValue(null);

      await expect(service.cancelOwnOrder('o1', 'c1')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(dispatcher.notifyClientCancelled).not.toHaveBeenCalled();
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

    it('treats a missing client as 0 bottles on hand when recomputing (defensive)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'REPEAT',
        electro: false,
        pumpAddon: false,
      });
      clients.getById.mockResolvedValue(null);
      prisma.order.update.mockResolvedValue({ id: 'o1' });

      await service.editQuantity('o1', 2);

      // bottlesOnHand defaults to 0 → the whole order is new tara under deposit.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { bottles: 2, newTara: 2, totalPrice: 2 * 70 + 2 * 450 },
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

    it('emits the order-edited event so the client is notified', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'REPEAT',
      });
      const updated = { id: 'o1', bottles: 3, clientId: 'c1' };
      prisma.order.update.mockResolvedValue(updated);

      await service.editQuantity('o1', 3);

      expect(events.emit).toHaveBeenCalledWith('order.edited', {
        order: updated,
      });
    });
  });

  describe('editOrderAddress / editOrderComment (dispatcher content edit)', () => {
    it('writes the new address text, returns the view and notifies the client', async () => {
      prisma.order.findUniqueOrThrow
        .mockResolvedValueOnce({ id: 'o1', addressId: 'a1', status: 'CREATED' })
        .mockResolvedValueOnce({
          id: 'o1',
          clientId: 'c1',
          address: { id: 'a1' },
        });

      await service.editOrderAddress('o1', 'вул. Нова 5');

      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { raw: 'вул. Нова 5' },
      });
      expect(events.emit).toHaveBeenCalledWith('order.edited', {
        order: { id: 'o1', clientId: 'c1', address: { id: 'a1' } },
      });
    });

    it('writes the new comment on an accepted order', async () => {
      prisma.order.findUniqueOrThrow
        .mockResolvedValueOnce({
          id: 'o1',
          addressId: 'a1',
          status: 'ACCEPTED',
        })
        .mockResolvedValueOnce({
          id: 'o1',
          clientId: 'c1',
          address: { id: 'a1' },
        });

      await service.editOrderComment('o1', 'код 42');

      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { comment: 'код 42' },
      });
    });

    it('a delivered/cancelled order cannot be edited (no write, no event)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        addressId: 'a1',
        status: 'DELIVERED',
      });

      await expect(service.editOrderAddress('o1', 'x')).rejects.toThrow();
      expect(prisma.address.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('setDeliveryNote (dispatcher delivery-timing message to client)', () => {
    it('stores the note on an active order and emits the delivery-note event', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      const updated = { id: 'o1', clientId: 'c1', deliveryNote: 'сьогодні' };
      prisma.order.update.mockResolvedValue(updated);

      await service.setDeliveryNote('o1', 'сьогодні');

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { deliveryNote: 'сьогодні' },
        include: { client: true, address: true },
      });
      expect(events.emit).toHaveBeenCalledWith('order.delivery-note', {
        order: updated,
      });
    });

    it('rejects a delivered/cancelled order (nothing to reschedule)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'DELIVERED',
      });

      await expect(service.setDeliveryNote('o1', 'завтра')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('setOrderAddressGeo (dispatcher geo-tagging)', () => {
    it("writes lat/lng to the order's address and returns the refreshed view", async () => {
      prisma.order.findUniqueOrThrow
        .mockResolvedValueOnce({ id: 'o1', addressId: 'a1' })
        .mockResolvedValueOnce({
          id: 'o1',
          address: { id: 'a1', lat: 49.42, lng: 26.99 },
          client,
        });

      await service.setOrderAddressGeo('o1', 49.42, 26.99);

      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { lat: 49.42, lng: 26.99 },
      });
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

  describe('quote (confirmation price preview, no order created)', () => {
    it('REPEAT with enough tara: water by grid, perBottle set, no order/notification', async () => {
      // shared client bottlesOnHand=5, past orders exist → REPEAT.
      prisma.order.count.mockResolvedValue(2);

      const q = await service.quote('c1', 2);

      expect(q).toEqual({
        kind: 'REPEAT',
        bottles: 2,
        totalPrice: 140,
        perBottle: 70,
        newTara: 0,
        depositPerBottle: 450,
        pumpPrice: 250,
        electroPumpPrice: 270,
        waterStartPrice: 50,
        electro: false,
        pumpAddon: false,
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(dispatcher.notifyNewOrder).not.toHaveBeenCalled();
    });

    it('STARTER_KIT: perBottle is null (kit price is not per-bottle)', async () => {
      clients.getById.mockResolvedValue({ ...client, bottlesOnHand: 0 });
      prisma.order.count.mockResolvedValue(0);

      const q = await service.quote('c1', 1);

      expect(q.kind).toBe('STARTER_KIT');
      expect(q.perBottle).toBeNull();
      expect(q.totalPrice).toBe(750);
      expect(q.newTara).toBe(1);
    });

    it('OWN_TARA claim with a tara top-up: deposit only on the bottles above the claim', async () => {
      clients.getById.mockResolvedValue({ ...client, bottlesOnHand: 0 });
      prisma.order.count.mockResolvedValue(0); // first order

      const q = await service.quote('c1', 4, { claimedOnHand: 3 });

      expect(q.kind).toBe('OWN_TARA');
      expect(q.newTara).toBe(1); // order 4, claimed 3 → 1 new under deposit
      expect(q.totalPrice).toBe(730); // 4×70 + 1×450
      expect(q.perBottle).toBe(70);
    });

    it('falls back to STARTER_KIT when the client is unknown (defensive)', async () => {
      clients.getById.mockResolvedValue(null);
      const q = await service.quote('missing', 2);
      expect(q.kind).toBe('STARTER_KIT');
    });
  });

  describe('quote / createOrder price consistency (the preview must equal what is charged)', () => {
    const scenarios: {
      name: string;
      bottlesOnHand: number;
      count: number;
      bottles: number;
      opts?: { electro?: boolean; pumpAddon?: boolean; claimedOnHand?: number };
    }[] = [
      { name: 'REPEAT enough tara', bottlesOnHand: 5, count: 3, bottles: 2 },
      { name: 'REPEAT top-up', bottlesOnHand: 1, count: 3, bottles: 3 },
      {
        name: 'STARTER_KIT std',
        bottlesOnHand: 0,
        count: 0,
        bottles: 2,
      },
      {
        name: 'STARTER_KIT electro',
        bottlesOnHand: 0,
        count: 0,
        bottles: 1,
        opts: { electro: true },
      },
      {
        name: 'OWN_TARA claim + top-up',
        bottlesOnHand: 0,
        count: 0,
        bottles: 4,
        opts: { claimedOnHand: 3 },
      },
      {
        name: 'OWN_TARA claim + pump add-on',
        bottlesOnHand: 0,
        count: 0,
        bottles: 2,
        opts: { claimedOnHand: 2, pumpAddon: true },
      },
      {
        // Previously divergent edge: a 0 claim with a committed balance. Both methods
        // must normalize it to "no claim" and quote off the real balance (5).
        name: 'claim 0 with a committed balance (normalized alike)',
        bottlesOnHand: 5,
        count: 0,
        bottles: 2,
        opts: { claimedOnHand: 0 },
      },
    ];

    it.each(scenarios)(
      '$name: quote.totalPrice === createOrder totalPrice',
      async ({ bottlesOnHand, count, bottles, opts }) => {
        clients.getById.mockResolvedValue({ ...client, bottlesOnHand });
        prisma.order.count.mockResolvedValue(count);
        let createdTotal: number | undefined;
        prisma.order.create.mockImplementation(
          (args: { data: { totalPrice: number } }) => {
            createdTotal = args.data.totalPrice;
            return Promise.resolve({ id: 'o1', ...args.data });
          },
        );

        const q = await service.quote('c1', bottles, opts);
        await service.createOrder('c1', bottles, opts);

        expect(q.totalPrice).toBe(createdTotal);
      },
    );
  });

  describe('stats (/stats summary)', () => {
    it('sums today and the week without cancelled orders', async () => {
      prisma.order.count.mockResolvedValue(0); // building the tx array
      prisma.order.aggregate.mockResolvedValue({ _sum: { totalPrice: 0 } });
      prisma.$transaction.mockResolvedValue([
        2,
        { _sum: { totalPrice: 500 } },
        7,
        { _sum: { totalPrice: 1800 } },
      ]);

      await expect(service.stats()).resolves.toEqual({
        today: { count: 2, sum: 500 },
        week: { count: 7, sum: 1800 },
      });
    });

    it('a null aggregate sum (no orders in the window) becomes 0, not null', async () => {
      prisma.$transaction.mockResolvedValue([
        0,
        { _sum: { totalPrice: null } },
        0,
        { _sum: { totalPrice: null } },
      ]);

      await expect(service.stats()).resolves.toEqual({
        today: { count: 0, sum: 0 },
        week: { count: 0, sum: 0 },
      });
    });
  });

  describe('cancelOrder (dispatcher cancellation)', () => {
    it('CREATED → CANCELLED and emits the status event (client is notified)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });
      const cancelled = { id: 'o1', clientId: 'c1', status: 'CANCELLED' };
      prisma.order.update.mockResolvedValue(cancelled);

      await service.cancelOrder('o1');

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: 'CANCELLED' },
      });
      expect(events.emit).toHaveBeenCalledWith('order.status.changed', {
        order: cancelled,
      });
    });

    it('ACCEPTED → CANCELLED is allowed (a dispatcher can still cancel an accepted order)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });

      await expect(service.cancelOrder('o1')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(prisma.order.update).toHaveBeenCalled();
    });

    it('an already CANCELLED order cannot be cancelled again', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CANCELLED',
      });

      await expect(service.cancelOrder('o1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('markDelivered — tara credit by kind (creditTara)', () => {
    it('REPEAT credits only the tara top-up (bottles above the remainder), no pump', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        kind: 'REPEAT',
        bottles: 3,
        newTara: 1,
        pumpAddon: false,
        status: 'DELIVERED',
      });

      await service.markDelivered('o1');

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { bottlesOnHand: { increment: 1 } },
      });
    });

    it('OWN_TARA with no top-up and no pump credits nothing (client is not touched)', async () => {
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
        pumpAddon: false,
        status: 'DELIVERED',
      });

      await service.markDelivered('o1');

      // Nothing to credit → no client write at all.
      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('a tara-credit failure does not break an already completed delivery (best-effort)', async () => {
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
      prisma.client.update.mockRejectedValue(new Error('db down'));

      await expect(service.markDelivered('o1')).resolves.toMatchObject({
        status: 'DELIVERED',
      });
      // the status event still fires despite the accounting failure.
      expect(events.emit).toHaveBeenCalledWith('order.status.changed', {
        order: expect.objectContaining({ status: 'DELIVERED' }) as object,
      });
    });
  });

  describe('read helpers (dispatcher/client screens)', () => {
    it('listByClient: newest first, default limit 5, cancelled included', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);

      await service.listByClient('c1');

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });

    it('listActive: only CREATED/ACCEPTED, oldest first (FIFO), with relations', async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.listActive();

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['CREATED', 'ACCEPTED'] } },
        orderBy: { createdAt: 'asc' },
        take: 20,
        include: { client: true, address: true },
      });
    });

    it('getOrderView: fetches the order with client + address', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'o1' });

      await service.getOrderView('o1');

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: 'o1' },
        include: { client: true, address: true },
      });
    });

    it('findByShortIdPrefix: prefix match on id with client+address relations, newest first', async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await service.findByShortIdPrefix('a1b2c3d4');

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'a1b2c3d4' } },
        orderBy: { createdAt: 'desc' },
        include: { client: true, address: true },
      });
    });

    it('findByShortIdPrefix: no match → empty array', async () => {
      prisma.order.findMany.mockResolvedValue([]);

      await expect(service.findByShortIdPrefix('deadbeef')).resolves.toEqual(
        [],
      );
    });

    it('findByShortIdPrefix: a single match is returned', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'a1b2c3d4-...' }]);

      await expect(service.findByShortIdPrefix('a1b2c3d4')).resolves.toEqual([
        { id: 'a1b2c3d4-...' },
      ]);
    });

    it('findByShortIdPrefix: multiple matches (short-prefix collision) are all returned', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'a1b2c3d4-1' },
        { id: 'a1b2c3d4-2' },
      ]);

      await expect(
        service.findByShortIdPrefix('a1b2c3d4'),
      ).resolves.toHaveLength(2);
    });

    it('waterUnitPrice: live grid price per bottle for the quantity (6 → from-6 tier)', async () => {
      await expect(service.waterUnitPrice(6)).resolves.toBe(65);
      await expect(service.waterUnitPrice(1)).resolves.toBe(80);
    });
  });

  describe('setOrderAddressGeo edge', () => {
    it('rejects when the order does not exist (findUniqueOrThrow throws)', async () => {
      prisma.order.findUniqueOrThrow.mockRejectedValue(new Error('not found'));

      await expect(
        service.setOrderAddressGeo('missing', 49, 26),
      ).rejects.toThrow();
      expect(prisma.address.update).not.toHaveBeenCalled();
    });
  });
});
