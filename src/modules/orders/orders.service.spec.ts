import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ClientsService } from '../clients/clients.service';
import type { PricingSettingsService } from '../pricing-settings/pricing-settings.service';
import { PricingService } from '../pricing/pricing.service';
import { OrdersService } from './orders.service';

// PrismaService тянет сгенерированный клиент Prisma 7 (ESM, import.meta), который
// ts-jest не компилирует под CommonJS. В юнит-тесте клиент не нужен — мокаем модуль.
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
  raw: 'ул. 1',
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
    };
    events = { emit: jest.fn() };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      clients as unknown as ClientsService,
      new PricingService(),
      pricingSettings as unknown as PricingSettingsService,
      // mock структурно совместим с OrderDispatcher (notifyNewOrder/notifyClientCancelled).
      dispatcher,
      events as unknown as EventEmitter2,
    );
  });

  // Проверки идут через типизированные моки prisma.order.* / dispatcher.notifyNewOrder:
  // возвращаемый сервисом Order приходит из сгенерированного клиента и в контексте
  // юнит-теста выводится как any, поэтому assertions строим на аргументах вызовов.
  describe('createOrder', () => {
    it('первый заказ: kind=STARTER_KIT, сумма по стартовому комплекту (1 бак → 750)', async () => {
      // Новичок без своей тары → STARTER_KIT (deriveKind смотрит bottlesOnHand).
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
          electro: false,
          pumpAddon: false,
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

    it('повторный заказ: kind=REPEAT, сумма по сетке воды (2 бутыли → 140)', async () => {
      const created = { id: 'o2', kind: 'REPEAT', totalPrice: 140 };
      prisma.order.count.mockResolvedValue(3); // есть прошлые активные заказы
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          kind: 'REPEAT',
          electro: false,
          pumpAddon: false,
          totalPrice: 140,
          status: 'CREATED',
        },
      });
    });

    it('первый заказ со своей тарой (bottlesOnHand>0) → kind=OWN_TARA, только вода (2 → 140)', async () => {
      // shared client: bottlesOnHand=5 → первый заказ распознаётся как своя тара.
      const created = { id: 'o3', kind: 'OWN_TARA', totalPrice: 140 };
      prisma.order.count.mockResolvedValue(0); // первый заказ
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          kind: 'OWN_TARA',
          electro: false,
          pumpAddon: false,
          totalPrice: 140,
          status: 'CREATED',
        },
      });
    });

    it('бросает ошибку, если у клиента нет default-адреса, и заказ не создаётся', async () => {
      clients.getDefaultAddress.mockResolvedValue(null);
      prisma.order.count.mockResolvedValue(0);

      await expect(service.createOrder('c1', 1)).rejects.toThrow();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('lastBottles', () => {
    it('возвращает bottles последнего не-отменённого заказа', async () => {
      prisma.order.findFirst.mockResolvedValue({ bottles: 3 });

      const result = await service.lastBottles('c1');

      expect(result).toBe(3);
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { bottles: true },
      });
    });

    it('возвращает null, если повторять нечего', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.lastBottles('c1')).resolves.toBeNull();
    });
  });

  describe('переходы статусов', () => {
    it('acceptOrder: CREATED → ACCEPTED + снимает pendingReview клиента', async () => {
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

      // приём = сверка заявленного действующего клиента диспетчером (T4).
      expect(clients.setTaraState).toHaveBeenCalledWith('c1', {
        pendingReview: false,
      });

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // where включает status: from — атомарный гард перехода (см. transition).
          where: { id: 'o1', status: 'CREATED' },
          // as object: expect.objectContaining() типизирован как any (jest),
          // каст снимает no-unsafe-assignment при вложении в литерал.
          data: expect.objectContaining({ status: 'ACCEPTED' }) as object,
        }),
      );
      // диспетчерский переход эмитит событие — клиентский бот уведомит клиента.
      expect(events.emit).toHaveBeenCalledWith('order.status.changed', {
        order: { id: 'o1', clientId: 'c1', status: 'ACCEPTED' },
      });
    });

    it('markDelivered: ACCEPTED → DELIVERED начисляет новую тару клиенту (STARTER_KIT 2 → +2)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
      });
      prisma.order.update.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        kind: 'STARTER_KIT',
        bottles: 2,
        status: 'DELIVERED',
      });

      await service.markDelivered('o1');

      // STARTER_KIT → все баки в оборот + помпа (комплект) у клиента.
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { bottlesOnHand: { increment: 2 }, hasPump: true },
      });
    });

    it('markDelivered из CREATED (минуя ACCEPTED) бросает ошибку', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });

      await expect(service.markDelivered('o1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('cancelOrder из DELIVERED бросает ошибку', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'DELIVERED',
      });

      await expect(service.cancelOrder('o1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelOwnOrder (отмена клиентом)', () => {
    it('отменяет свой CREATED-заказ и уведомляет диспетчера', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'CREATED',
      });
      const cancelled = { id: 'o1', clientId: 'c1', status: 'CANCELLED' };
      prisma.order.update.mockResolvedValue(cancelled);

      await service.cancelOwnOrder('o1', 'c1');

      expect(prisma.order.update).toHaveBeenCalledWith({
        // where включает status — атомарный гард от гонки с принятием.
        where: { id: 'o1', status: 'CREATED' },
        data: { status: 'CANCELLED' },
      });
      expect(dispatcher.notifyClientCancelled).toHaveBeenCalledWith(
        cancelled,
        client,
      );
      // самоотмену клиенту НЕ пушим (он сам инициировал) — событие не эмитится.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('чужой заказ отменить нельзя (не тот clientId)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'другой',
        status: 'CREATED',
      });

      await expect(service.cancelOwnOrder('o1', 'c1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(dispatcher.notifyClientCancelled).not.toHaveBeenCalled();
    });

    it('уже принятый заказ (ACCEPTED) клиент отменить не может', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        clientId: 'c1',
        status: 'ACCEPTED',
      });

      await expect(service.cancelOwnOrder('o1', 'c1')).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('сбой уведомления диспетчера не валит отмену', async () => {
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

  describe('editQuantity (правка диспетчером)', () => {
    it('пересчитывает сумму повторного заказа (3 бутыли → 210) и обновляет', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
        kind: 'REPEAT',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', bottles: 3 });

      await service.editQuantity('o1', 3);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { bottles: 3, totalPrice: 210 },
        include: { client: true, address: true },
      });
    });

    it('первый заказ пересчитывается по стартовому комплекту (2 → 1250)', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'ACCEPTED',
        kind: 'STARTER_KIT',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1' });

      await service.editQuantity('o1', 2);

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { bottles: 2, totalPrice: 1250 },
        }),
      );
    });

    it('доставленный заказ менять нельзя', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'DELIVERED',
        kind: 'REPEAT',
      });

      await expect(service.editQuantity('o1', 3)).rejects.toThrow();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });
});
