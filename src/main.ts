import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { collectConfigWarnings } from './config/env-check';

async function bootstrap() {
  // Surface missing/placeholder critical config as a clear boot warning instead of
  // silent degradation (a bot that never starts, a bogus support phone). Non-fatal.
  const warnings = collectConfigWarnings(process.env);
  if (warnings.length) {
    const logger = new Logger('ConfigCheck');
    for (const w of warnings) logger.warn(w);
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
