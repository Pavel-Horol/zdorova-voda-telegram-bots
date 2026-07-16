import { Module } from '@nestjs/common';
import { DispatchersService } from './dispatchers.service';

/**
 * Dispatcher chats (CLAUDE.md "Два бота — два токена"): the super-admin (env
 * DISPATCHER_CHAT_ID) plus DB rows managed from the bot. Used by the dispatcher bot
 * (chat guard + /dispatchers management) and by OrdersModule (order broadcast target).
 * DB access only via DispatchersService (§6).
 */
@Module({
  providers: [DispatchersService],
  exports: [DispatchersService],
})
export class DispatchersModule {}
