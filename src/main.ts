import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  collectConfigWarnings,
  supportPhoneConfigured,
} from './config/env-check';

async function bootstrap() {
  const logger = new Logger('ConfigCheck');
  // Surface missing critical config as a clear boot warning instead of silent
  // degradation (a bot that never starts). Non-fatal — a partial run stays possible.
  const warnings = collectConfigWarnings(process.env);
  for (const w of warnings) logger.warn(w);

  // FATAL: SUPPORT_PHONE is the guaranteed fallback for "Зв'язатися" (shown when the
  // dispatcher has no active number). Booting without it would leave the client a dead
  // end, so refuse to start — the dispatcher-managed numbers are an addition, not this.
  if (!supportPhoneConfigured(process.env)) {
    logger.error(
      'SUPPORT_PHONE не задано або лишилась заглушка — це резервний номер підтримки, без нього бот не стартує.',
    );
    throw new Error('SUPPORT_PHONE is required (fallback support phone)');
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
