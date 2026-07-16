import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Dispatcher } from '../../../generated/prisma/client';

/**
 * Merges the super-admin chat id (env DISPATCHER_CHAT_ID) with the active DB dispatcher
 * chat ids into the deduped allowed set (pure — unit-tested). Empty/whitespace admin is
 * dropped; the admin is always first when present. The chat guard and the order
 * broadcast both reduce to this set — one source of truth for "who is a dispatcher".
 */
export function mergeDispatcherChatIds(
  adminChatId: string | undefined,
  activeChatIds: string[],
): string[] {
  const admin = adminChatId?.trim();
  const ids = [admin, ...activeChatIds].filter((v): v is string => !!v);
  return [...new Set(ids)];
}

/**
 * Dispatcher chats managed from the dispatcher bot (/dispatchers) by the super-admin
 * (env DISPATCHER_CHAT_ID — never stored here, always admitted). Regular dispatchers
 * are DB rows: add / hide / delete. The allowed set = env admin ∪ active rows (see
 * {@link mergeDispatcherChatIds}). DB access only here (CLAUDE.md §6); mirrors ContactsService.
 */
@Injectable()
export class DispatchersService {
  constructor(private readonly prisma: PrismaService) {}

  /** All rows, oldest first — for the super-admin management list (active + hidden). */
  listAll(): Promise<Dispatcher[]> {
    return this.prisma.dispatcher.findMany({ orderBy: { createdAt: 'asc' } });
  }

  /** Chat ids of the active rows (excludes the env admin — merged in separately). */
  async listActiveChatIds(): Promise<string[]> {
    const rows = await this.prisma.dispatcher.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.chatId);
  }

  /**
   * The full allowed set (env admin ∪ active DB rows), deduped. Called on every update
   * by the chat guard and on every broadcast — a fresh query so a just-added dispatcher
   * works immediately (the table is tiny; no cache to invalidate).
   */
  async allowedChatIds(adminChatId: string | undefined): Promise<string[]> {
    return mergeDispatcherChatIds(adminChatId, await this.listActiveChatIds());
  }

  /**
   * Adds (or re-activates) a dispatcher by chat id. A duplicate chat id is re-activated
   * and its label refreshed instead of erroring — re-adding a hidden dispatcher just
   * shows them again (idempotent, CLAUDE.md rule 9). Validation is the caller's (fsm).
   */
  add(chatId: string, label: string | null): Promise<Dispatcher> {
    return this.prisma.dispatcher.upsert({
      where: { chatId },
      update: { active: true, label },
      create: { chatId, label, active: true },
    });
  }

  /** Shows/hides a dispatcher without deleting the row (soft toggle). */
  setActive(id: string, active: boolean): Promise<Dispatcher> {
    return this.prisma.dispatcher.update({ where: { id }, data: { active } });
  }

  /** Permanently removes a dispatcher. */
  remove(id: string): Promise<Dispatcher> {
    return this.prisma.dispatcher.delete({ where: { id } });
  }
}
