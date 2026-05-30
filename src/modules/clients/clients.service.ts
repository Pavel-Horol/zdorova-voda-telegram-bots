import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Client, Address } from '../../../generated/prisma/client';

export interface CreateClientInput {
  telegramId: bigint;
  phone: string;
  name?: string | null;
}

export interface AddAddressInput {
  raw: string;
  comment?: string | null;
  isDefault?: boolean;
}

/**
 * Клиенты и их адреса (SPEC §4). Доступ к БД — только здесь, внутри сервиса
 * модуля; боты обращаются к данным клиента через этот сервис (CLAUDE.md §6).
 */
@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  findByTelegramId(telegramId: bigint): Promise<Client | null> {
    return this.prisma.client.findUnique({ where: { telegramId } });
  }

  findByPhone(phone: string): Promise<Client | null> {
    return this.prisma.client.findUnique({ where: { phone } });
  }

  getById(id: string): Promise<Client | null> {
    return this.prisma.client.findUnique({ where: { id } });
  }

  create(input: CreateClientInput): Promise<Client> {
    return this.prisma.client.create({
      data: {
        telegramId: input.telegramId,
        phone: input.phone,
        name: input.name ?? null,
      },
    });
  }

  listAddresses(clientId: string): Promise<Address[]> {
    return this.prisma.address.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
    });
  }

  getDefaultAddress(clientId: string): Promise<Address | null> {
    return this.prisma.address.findFirst({
      where: { clientId, isDefault: true },
    });
  }

  /**
   * Привязывает адрес к клиенту. Если isDefault=true — снимает флаг с прочих
   * адресов клиента в одной транзакции, чтобы default всегда был один.
   */
  async addAddress(clientId: string, input: AddAddressInput): Promise<Address> {
    const makeDefault = input.isDefault ?? false;

    if (!makeDefault) {
      return this.prisma.address.create({
        data: {
          clientId,
          raw: input.raw,
          comment: input.comment ?? null,
          isDefault: false,
        },
      });
    }

    const [, address] = await this.prisma.$transaction([
      this.prisma.address.updateMany({
        where: { clientId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.address.create({
        data: {
          clientId,
          raw: input.raw,
          comment: input.comment ?? null,
          isDefault: true,
        },
      }),
    ]);

    return address;
  }
}
