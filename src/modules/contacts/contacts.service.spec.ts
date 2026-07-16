import type { PrismaService } from '../../prisma/prisma.service';
import type { ContactPhone } from '../../../generated/prisma/client';
import { ContactsService, normalizeContactPhone } from './contacts.service';

// PrismaService pulls the generated Prisma 7 client (ESM, import.meta), which ts-jest
// does not compile under CommonJS. Not needed in the unit test — mock the module so the
// real import does not run; Prisma is injected via our own mock object.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

function makeContact(over: Partial<ContactPhone> = {}): ContactPhone {
  return {
    id: 'c1',
    phone: '+380501234567',
    active: true,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
}

describe('normalizeContactPhone', () => {
  it('keeps an international number, stripping punctuation', () => {
    expect(normalizeContactPhone('+380 50 123 45 67')).toBe('+380501234567');
    expect(normalizeContactPhone('380501234567')).toBe('+380501234567');
  });

  it('expands a Ukrainian national 0XXXXXXXXX to +380XXXXXXXXX', () => {
    expect(normalizeContactPhone('0501234567')).toBe('+380501234567');
    expect(normalizeContactPhone('(050) 123-45-67')).toBe('+380501234567');
  });

  it('rejects too few / too many digits and non-numbers', () => {
    expect(normalizeContactPhone('12345')).toBeNull();
    expect(normalizeContactPhone('1234567890123456')).toBeNull();
    expect(normalizeContactPhone('телефон')).toBeNull();
    expect(normalizeContactPhone('')).toBeNull();
  });
});

describe('ContactsService', () => {
  let service: ContactsService;
  let prisma: {
    contactPhone: {
      findMany: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      contactPhone: {
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new ContactsService(prisma as unknown as PrismaService);
  });

  it('listAll reads every number oldest-first', async () => {
    const rows = [makeContact()];
    prisma.contactPhone.findMany.mockResolvedValue(rows);
    await expect(service.listAll()).resolves.toEqual(rows);
    expect(prisma.contactPhone.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
    });
  });

  it('listActive filters to active numbers only', async () => {
    prisma.contactPhone.findMany.mockResolvedValue([]);
    await service.listActive();
    expect(prisma.contactPhone.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  describe('add', () => {
    it('normalizes then upserts (re-activating a duplicate)', async () => {
      const row = makeContact();
      prisma.contactPhone.upsert.mockResolvedValue(row);
      await expect(service.add('0501234567')).resolves.toEqual(row);
      expect(prisma.contactPhone.upsert).toHaveBeenCalledWith({
        where: { phone: '+380501234567' },
        update: { active: true },
        create: { phone: '+380501234567', active: true },
      });
    });

    it('throws on an invalid number and does not touch the DB', () => {
      expect(() => service.add('123')).toThrow();
      expect(prisma.contactPhone.upsert).not.toHaveBeenCalled();
    });
  });

  it('setActive toggles the stored flag by id', async () => {
    const row = makeContact({ active: false });
    prisma.contactPhone.update.mockResolvedValue(row);
    await expect(service.setActive('c1', false)).resolves.toEqual(row);
    expect(prisma.contactPhone.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { active: false },
    });
  });

  it('remove deletes by id', async () => {
    const row = makeContact();
    prisma.contactPhone.delete.mockResolvedValue(row);
    await expect(service.remove('c1')).resolves.toEqual(row);
    expect(prisma.contactPhone.delete).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });
});
