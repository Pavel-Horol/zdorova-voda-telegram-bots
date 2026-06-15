import { Module } from '@nestjs/common';
import { DISPATCHER_BOT, dispatcherBotProvider } from './dispatcher-bot.bot';

/**
 * The shared dispatcher bot instance as a separate module: imported by both
 * OrdersModule (to send notifications via TelegramOrderDispatcher) and
 * DispatcherBotModule (to handle commands/buttons). One Bot for both directions.
 */
@Module({
  providers: [dispatcherBotProvider],
  exports: [DISPATCHER_BOT],
})
export class DispatcherBotCoreModule {}
