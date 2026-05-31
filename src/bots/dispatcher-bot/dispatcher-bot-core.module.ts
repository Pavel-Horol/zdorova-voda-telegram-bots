import { Module } from '@nestjs/common';
import { DISPATCHER_BOT, dispatcherBotProvider } from './dispatcher-bot.bot';

/**
 * Общий инстанс диспетчерского бота как отдельный модуль: его импортируют и
 * OrdersModule (для отправки уведомлений через TelegramOrderDispatcher), и
 * DispatcherBotModule (для приёма команд/кнопок). Один Bot на оба направления.
 */
@Module({
  providers: [dispatcherBotProvider],
  exports: [DISPATCHER_BOT],
})
export class DispatcherBotCoreModule {}
