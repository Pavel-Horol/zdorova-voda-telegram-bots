import type { PrismaService } from '../../prisma/prisma.service';
import { ClientsService } from './clients.service';

// PrismaService pulls the generated Prisma 7 client (ESM, import.meta), which
// ts-jest does not compile under CommonJS. The client is not needed in the unit test — mock the module.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('ClientsService', () => {
  let service: ClientsService;
  let prisma: {
    client: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
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
      client: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
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

  describe('searchByPhone', () => {
    it('matches clients whose phone contains the token, newest first, capped', async () => {
      const found = [{ id: 'c1', phone: '+380501234567' }];
      prisma.client.findMany.mockResolvedValue(found);

      await expect(service.searchByPhone('501234567')).resolves.toEqual(found);
      expect(prisma.client.findMany).toHaveBeenCalledWith({
        where: { phone: { contains: '501234567' } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });
  });

  describe('getDefaultAddress', () => {
    it('looks up the client default address', async () => {
      const addr = { id: 'a1', isDefault: true };
      prisma.address.findFirst.mockResolvedValue(addr);

      await expect(service.getDefaultAddress('c1')).resolves.toEqual(addr);
      expect(prisma.address.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1', isDefault: true },
      });
    });
  });

  describe('addAddress', () => {
    it('creates a regular (non-default) address without a transaction', async () => {
      const addr = { id: 'a1', isDefault: false };
      prisma.address.create.mockResolvedValue(addr);

      await expect(service.addAddress('c1', { raw: 'St. 1' })).resolves.toEqual(
        addr,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'St. 1', comment: null, isDefault: false },
      });
    });

    it('on isDefault resets the old default within a transaction', async () => {
      const addr = { id: 'a2', isDefault: true };
      // $transaction receives an array of prisma operations and returns their results:
      // [updateMany result, the created address].
      prisma.$transaction.mockResolvedValue([{ count: 1 }, addr]);

      await expect(
        service.addAddress('c1', { raw: 'St. 2', isDefault: true }),
      ).resolves.toEqual(addr);

      expect(prisma.address.updateMany).toHaveBeenCalledWith({
        where: { clientId: 'c1', isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'St. 2', comment: null, isDefault: true },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('setTaraState', () => {
    it('overwrites the client tara balance and pump', async () => {
      const updated = { id: 'c1', bottlesOnHand: 3, hasPump: true };
      prisma.client.update.mockResolvedValue(updated);

      await expect(
        service.setTaraState('c1', { bottlesOnHand: 3, hasPump: true }),
      ).resolves.toEqual(updated);
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { bottlesOnHand: 3, hasPump: true },
      });
    });
  });

  describe('setDefaultAddress', () => {
    it('updates the existing default address (without creating a dupe) and drops a stale geo-pin on a raw change', async () => {
      prisma.address.findFirst.mockResolvedValue({
        id: 'a1',
        isDefault: true,
        raw: 'St. 1',
      });
      prisma.address.update.mockResolvedValue({ id: 'a1', raw: 'St. 9' });

      await service.setDefaultAddress('c1', {
        raw: 'St. 9',
        comment: 'floor 3',
      });

      // raw changed (St. 1 → St. 9) → coordinates of the old place are invalidated.
      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { raw: 'St. 9', comment: 'floor 3', lat: null, lng: null },
      });
      expect(prisma.address.create).not.toHaveBeenCalled();
    });

    it('keeps the geo-pin when only the comment changes (raw unchanged)', async () => {
      prisma.address.findFirst.mockResolvedValue({
        id: 'a1',
        isDefault: true,
        raw: 'St. 1',
      });
      prisma.address.update.mockResolvedValue({ id: 'a1', raw: 'St. 1' });

      await service.setDefaultAddress('c1', {
        raw: 'St. 1',
        comment: 'code 42',
      });

      // raw is the same → lat/lng are not touched (no stale-pin reset).
      expect(prisma.address.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { raw: 'St. 1', comment: 'code 42' },
      });
    });

    it('creates a default address if there is none yet', async () => {
      prisma.address.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockResolvedValue([{ count: 0 }, { id: 'a2' }]);

      await service.setDefaultAddress('c1', { raw: 'St. 1' });

      expect(prisma.address.update).not.toHaveBeenCalled();
      expect(prisma.address.create).toHaveBeenCalledWith({
        data: { clientId: 'c1', raw: 'St. 1', comment: null, isDefault: true },
      });
    });
  });
});
