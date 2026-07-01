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

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  findByTelegramId(telegramId: bigint): Promise<Client | null> {
    return this.prisma.client.findUnique({ where: { telegramId } });
  }

  findByPhone(phone: string): Promise<Client | null> {
    return this.prisma.client.findUnique({ where: { phone } });
  }

  /**
   * Looks up clients by a phone-number fragment (dispatcher 🔎 Клієнт). `token` is a
   * digit substring (see phoneSearchToken); matches any stored phone containing it.
   * Newest first, capped — a lookup, not a full scan.
   */
  searchByPhone(token: string, limit = 5): Promise<Client[]> {
    return this.prisma.client.findMany({
      where: { phone: { contains: token } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
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

  getDefaultAddress(clientId: string): Promise<Address | null> {
    return this.prisma.address.findFirst({
      where: { clientId, isDefault: true },
    });
  }

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

  /**
   * Sets the client's tara/pump state (OWN_TARA onboarding: the client entered the
   * number of their own bottles; dispatcher confirmation of "I am already a client").
   * Overwrites, does not increment — this is the declared starting balance, not a delivery.
   */
  setTaraState(
    clientId: string,
    input: {
      bottlesOnHand?: number;
      hasPump?: boolean;
      pendingReview?: boolean;
    },
  ): Promise<Client> {
    return this.prisma.client.update({
      where: { id: clientId },
      data: input,
    });
  }

  // TEMP self-delete (test only) — remove this method when done.
  async deleteByTelegramId(telegramId: bigint): Promise<boolean> {
    const { count } = await this.prisma.client.deleteMany({
      where: { telegramId },
    });
    return count > 0;
  }
  // END TEMP

  async setDefaultAddress(
    clientId: string,
    input: { raw: string; comment?: string | null },
  ): Promise<Address> {
    const existing = await this.getDefaultAddress(clientId);
    if (existing) {
      // The dispatcher's geo-pin belongs to the PREVIOUS raw text. If the street/house
      // changes, the pin no longer matches — drop it so a stale point doesn't route the
      // driver to the old place (the dispatcher re-tags). A comment-only edit keeps it.
      const rawChanged = existing.raw !== input.raw;
      return this.prisma.address.update({
        where: { id: existing.id },
        data: {
          raw: input.raw,
          comment: input.comment ?? null,
          ...(rawChanged ? { lat: null, lng: null } : {}),
        },
      });
    }
    return this.addAddress(clientId, {
      raw: input.raw,
      comment: input.comment ?? null,
      isDefault: true,
    });
  }
}
