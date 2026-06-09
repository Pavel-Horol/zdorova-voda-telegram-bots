import type { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from './clients.service';

// PrismaService тянет сгенерированный клиент Prisma 7 (ESM, import.meta), который
// ts-jest не компилирует под CommonJS. В юнит-тесте клиент не нужен — мокаем модуль.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('ClientsService', () => {
  let service: ClientsService;
  let prisma: {
    client: { findUnique: jest.Mock; create: jest.Mock };
    address: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn(), create: jest.fn() },
      address: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    service = new ClientsService(prisma as unknown as PrismaService);
  });

  describe('getDefaultAddress', () => {
    it('ищет default-адрес клиента', async () => {
      const addr = { id: 'a1', isDefault: true };
      prisma.address.findFirst.mockResolvedValue(addr);

      await expect(service.getDefaultAddress('c1')).resolves.toEqual(addr);
      expect(prisma.address.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', isDefault: true },
      });
    });
  });

  describe('addAddress', () => {
    it('создаёт обычный (не default) адрес без транзакции', async () => {
      const addr = { id: 'a1', isDefault: false };
      prisma.address.create.mockResolvedValue(addr);

      await expect(service.addAddress('c1', { raw: 'ул. 1' })).resolves.toEqual(
        addr,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'ул. 1', comment: null, isDefault: false },
      });
    });

    it('при isDefault сбрасывает старый default в транзакции', async () => {
      const addr = { id: 'a2', isDefault: true };
      // $transaction получает массив prisma-операций и возвращает их результаты:
      // [результат updateMany, созданный адрес].
      prisma.$transaction.mockResolvedValue([{ count: 1 }, addr]);

      await expect(
        service.addAddress('c1', { raw: 'ул. 2', isDefault: true }),
      ).resolves.toEqual(addr);

      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { clientId: 'c1', isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'ул. 2', comment: null, isDefault: true },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('setDefaultAddress', () => {
    it('обновляет существующий default-адрес (без создания дубля)', async () => {
      prisma.address.findFirst.mockResolvedValue({ id: 'a1', isDefault: true });
      prisma.address.update.mockResolvedValue({ id: 'a1', raw: 'ул. 9' });

      await service.setDefaultAddress('c1', {
        raw: 'ул. 9',
        comment: 'этаж 3',
      });

      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { raw: 'ул. 9', comment: 'этаж 3' },
      });
      expect(prisma.address.create).not.toHaveBeenCalled();
    });

    it('создаёт default-адрес, если его ещё нет', async () => {
      prisma.address.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockResolvedValue([{ count: 0 }, { id: 'a2' }]);

      await service.setDefaultAddress('c1', { raw: 'ул. 1' });

      expect(prisma.address.update).not.toHaveBeenCalled();
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'ул. 1', comment: null, isDefault: true },
      });
    });
  });
});
