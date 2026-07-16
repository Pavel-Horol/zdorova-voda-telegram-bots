import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';

/**
 * Support contact phones (PRODUCT.md "Связаться"): dispatcher-managed numbers shown to
 * the client. Used by both bots — the client bot to render "Зв'язатися", the dispatcher
 * bot to manage the list. DB access only via ContactsService (CLAUDE.md §6).
 */
@Module({
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
