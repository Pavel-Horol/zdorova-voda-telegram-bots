import type { PrismaService } from '../../prisma/prisma.service';
import type { Dispatcher } from '../../../generated/prisma/client';
import {
  DispatchersService,
  mergeDispatcherChatIds,
} from './dispatchers.service';

// PrismaService pulls the generated Prisma 7 client (ESM, import.meta), which ts-jest
// does not compile under CommonJS. Not needed in the unit test — mock the module so the
// real import does not run; Prisma is injected via our own mock object.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

function makeDispatcher(over: Partial<Dispatcher> = {}): Dispatcher {
  return {
    id: 'd1',
    chatId: '111',
    label: 'Іван',
    active: true,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
}

describe('mergeDispatcherChatIds', () => {
  it('puts the env admin first and appends active db ids', () => {
    expect(mergeDispatcherChatIds('626688964', ['111', '222'])).toEqual([
      '626688964',
      '111',
      '222',
    ]);
  });

  it('dedupes an admin also present in the db and repeated db ids', () => {
    expect(mergeDispatcherChatIds('111', ['111', '222', '222'])).toEqual([
      '111',
      '222',
    ]);
  });

  it('drops an empty/whitespace admin', () => {
    expect(mergeDispatcherChatIds(undefined, ['111'])).toEqual(['111']);
    expect(mergeDispatcherChatIds('   ', ['111'])).toEqual(['111']);
  });

  it('returns just the admin when there are no db rows', () => {
    expect(mergeDispatcherChatIds('626688964', [])).toEqual(['626688964']);
  });
});

describe('DispatchersService', () => {
  let service: DispatchersService;
  let prisma: {
    dispatcher: {
      findMany: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      dispatcher: {
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn(),
      },
    };
    service = new DispatchersService(prisma as unknown as PrismaService);
  });

  it('listAll reads every row oldest-first', async () => {
    const rows = [makeDispatcher()];
    prisma.dispatcher.findMany.mockResolvedValue(rows);
    await expect(service.listAll()).resolves.toEqual(rows);
    expect(prisma.dispatcher.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
    });
  });

  it('listActiveChatIds filters to active and maps to chat ids', async () => {
    prisma.dispatcher.findMany.mockResolvedValue([
      makeDispatcher({ chatId: '111' }),
      makeDispatcher({ chatId: '222' }),
    ]);
    await expect(service.listActiveChatIds()).resolves.toEqual(['111', '222']);
    expect(prisma.dispatcher.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('allowedChatIds merges the env admin with active db ids', async () => {
    prisma.dispatcher.findMany.mockResolvedValue([
      makeDispatcher({ chatId: '111' }),
    ]);
    await expect(service.allowedChatIds('626688964')).resolves.toEqual([
      '626688964',
      '111',
    ]);
  });

  it('add upserts by chat id, re-activating and refreshing the label', async () => {
    const row = makeDispatcher();
    prisma.dispatcher.upsert.mockResolvedValue(row);
    await expect(service.add('111', 'Іван')).resolves.toEqual(row);
    expect(prisma.dispatcher.upsert).toHaveBeenCalledWith({
      where: { chatId: '111' },
      update: { active: true, label: 'Іван' },
      create: { chatId: '111', label: 'Іван', active: true },
    });
  });

  it('setActive toggles the stored flag by id', async () => {
    const row = makeDispatcher({ active: false });
    prisma.dispatcher.update.mockResolvedValue(row);
    await expect(service.setActive('d1', false)).resolves.toEqual(row);
    expect(prisma.dispatcher.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { active: false },
    });
  });

  it('remove deletes by id', async () => {
    const row = makeDispatcher();
    prisma.dispatcher.delete.mockResolvedValue(row);
    await expect(service.remove('d1')).resolves.toEqual(row);
    expect(prisma.dispatcher.delete).toHaveBeenCalledWith({
      where: { id: 'd1' },
    });
  });
  it('deleteAutoAdded matches BOTH the label and the age — never a hand-added row', async () => {
    prisma.dispatcher.deleteMany.mockResolvedValue({ count: 2 });
    const cutoff = new Date('2026-07-01T12:00:00.000Z');
    await expect(
      service.deleteAutoAdded('🧪 демо-відвідувач', cutoff),
    ).resolves.toBe(2);
    expect(prisma.dispatcher.deleteMany).toHaveBeenCalledWith({
      where: { label: '🧪 демо-відвідувач', createdAt: { lt: cutoff } },
    });
  });
  it('countAutoAdded counts only rows with that label', async () => {
    prisma.dispatcher.count.mockResolvedValue(1);
    await expect(service.countAutoAdded('🧪 демо-відвідувач')).resolves.toBe(1);
    expect(prisma.dispatcher.count).toHaveBeenCalledWith({
      where: { label: '🧪 демо-відвідувач' },
    });
  });
});
