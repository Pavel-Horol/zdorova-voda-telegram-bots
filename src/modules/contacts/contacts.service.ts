import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ContactPhone } from '../../../generated/prisma/client';

/**
 * Normalizes a dispatcher-typed phone to `+<digits>` (pure — unit-tested). Digits only;
 * a Ukrainian national number `0XXXXXXXXX` (10 digits) becomes `+380XXXXXXXXX`. Too few
 * (< 7) or too many (> 15, beyond E.164) digits → null (the handler asks to re-enter).
 */
export function normalizeContactPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  return `+${digits}`;
}

/**
 * Support contact phones shown to the client on "Зв'язатися" (PRODUCT.md). Managed by
 * the dispatcher (the bot is the admin — no web panel). The client reads only active
 * numbers; the env SUPPORT_PHONE stays as the guaranteed fallback. DB access lives here,
 * not in the bots (CLAUDE.md §6). Mirrors the PricingSettings singleton pattern.
 */
@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All numbers, oldest first — for the dispatcher management list (active + hidden). */
  listAll(): Promise<ContactPhone[]> {
    return this.prisma.contactPhone.findMany({ orderBy: { createdAt: 'asc' } });
  }

  /** Only the numbers shown to the client (active), oldest first. */
  listActive(): Promise<ContactPhone[]> {
    return this.prisma.contactPhone.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Adds a support phone. Normalizes the input; an invalid number throws (the handler
   * asks again). A duplicate number is re-activated instead of erroring — re-adding a
   * hidden number just shows it again (idempotent, CLAUDE.md rule 9).
   */
  add(rawPhone: string): Promise<ContactPhone> {
    const phone = normalizeContactPhone(rawPhone);
    if (!phone) throw new Error(`invalid contact phone: ${rawPhone}`);
    return this.prisma.contactPhone.upsert({
      where: { phone },
      update: { active: true },
      create: { phone, active: true },
    });
  }

  /** Shows/hides a number without deleting it (soft toggle). */
  setActive(id: string, active: boolean): Promise<ContactPhone> {
    return this.prisma.contactPhone.update({ where: { id }, data: { active } });
  }

  /** Permanently removes a number. */
  remove(id: string): Promise<ContactPhone> {
    return this.prisma.contactPhone.delete({ where: { id } });
  }
}
