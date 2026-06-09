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
  price2: 75,
  price3plus: 70,
  depositPerBottle: 300,
  pumpPrice: 200,
  updatedAt: new Date('2026-05-30T00:00:00.000Z'),
};

const client = {
  id: 'c1',
  telegramId: 1n,
  phone: '+380',
  name: null,
  createdAt: new Date(),
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
  };
  let clients: { getById: jest.Mock; getDefaultAddress: jest.Mock };
  let pricingSettings: { getCurrent: jest.Mock };
  let dispatcher: { notifyNewOrder: jest.Mock };

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
    };
    clients = {
      getById: jest.fn().mockResolvedValue(client),
      getDefaultAddress: jest.fn().mockResolvedValue(address),
    };
    pricingSettings = { getCurrent: jest.fn().mockResolvedValue(prices) };
    dispatcher = { notifyNewOrder: jest.fn().mockResolvedValue(undefined) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      clients as unknown as ClientsService,
      new PricingService(),
      pricingSettings as unknown as PricingSettingsService,
      // mock структурно совместим с OrderDispatcher (один метод notifyNewOrder).
      dispatcher,
    );
  });

  // Проверки идут через типизированные моки prisma.order.* / dispatcher.notifyNewOrder:
  // возвращаемый сервисом Order приходит из сгенерированного клиента и в контексте
  // юнит-теста выводится как any, поэтому assertions строим на аргументах вызовов.
  describe('createOrder', () => {
    it('первый заказ: isFirstOrder=true, сумма по стартовой сетке (1 бутыль → 500)', async () => {
      const created = { id: 'o1', isFirstOrder: true, totalPrice: 500 };
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
          isFirstOrder: true,
          totalPrice: 500,
          status: 'CREATED',
        },
      });
      expect(dispatcher.notifyNewOrder).toHaveBeenCalledWith(
        created,
        client,
        address,
      );
    });

    it('повторный заказ: isFirstOrder=false, сумма по обычной сетке (2 бутыли → 150)', async () => {
      const created = { id: 'o2', isFirstOrder: false, totalPrice: 150 };
      prisma.order.count.mockResolvedValue(3); // есть прошлые активные заказы
      prisma.order.create.mockResolvedValue(created);

      await service.createOrder('c1', 2);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: {
          clientId: 'c1',
          addressId: 'a1',
          bottles: 2,
          isFirstOrder: false,
          totalPrice: 150,
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
    it('acceptOrder: CREATED → ACCEPTED', async () => {
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'o1',
        status: 'CREATED',
      });
      prisma.order.update.mockResolvedValue({ id: 'o1', status: 'ACCEPTED' });

      await service.acceptOrder('o1');

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // where включает status: from — атомарный гард перехода (см. transition).
          where: { id: 'o1', status: 'CREATED' },
          data: expect.objectContaining({ status: 'ACCEPTED' }),
        }),
      );
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
});
