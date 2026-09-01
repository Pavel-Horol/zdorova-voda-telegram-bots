// MUST come first: puts the env file into process.env before any module metadata
// (which picks providers by env) is evaluated. See config/load-env.ts.
import { ENV_FILE } from './config/load-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  collectConfigWarnings,
  supportPhoneConfigured,
} from './config/env-check';
import { isDemoMode } from './config/demo';

async function bootstrap() {
  const logger = new Logger('ConfigCheck');
  logger.log(`config loaded from ${ENV_FILE}`);

  // The demo stand behaves differently in ways that would be alarming in production
  // (orders accept themselves, anyone is admitted to the dispatcher bot, visitor data
  // is deleted on a timer) — say so loudly, once, at boot.
  if (isDemoMode(process.env)) {
    logger.warn(
      'DEMO MODE — фейкові телефони замість реальних, авто-диспетчер, ' +
        '/reset для клієнта, відкритий диспетчерський бот, періодична чистка даних.',
    );
  }

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
