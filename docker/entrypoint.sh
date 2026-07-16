#!/bin/sh
# Prod-entrypoint контейнера приложения.
# Порядок важен: сначала приводим БД к актуальной схеме, потом стартуем процесс.
set -e

echo "→ prisma migrate deploy (применяю миграции к БД)..."
npx prisma migrate deploy

echo "→ старт бота (node dist/src/main)..."
# exec — чтобы node стал PID 1 и корректно получал SIGTERM от docker (graceful shutdown,
# enableShutdownHooks в main.ts закроет соединения). Без exec сигнал уйдёт в sh, а не в node.
exec node dist/src/main
