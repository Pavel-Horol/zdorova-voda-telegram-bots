#!/bin/sh
# Prod-entrypoint контейнера приложения.
# Порядок важен: сначала приводим БД к актуальной схеме, потом стартуем процесс.
set -e

# Внутри docker-сети хост БД — имя сервиса (`db`), а на хосте — localhost:порт. Один и
# тот же .env читают оба, поэтому контейнерный адрес приезжает отдельной переменной и
# подменяет DATABASE_URL здесь, а не через ${...} в compose: интерполяция молча даёт
# пустую строку, если compose запустили без --env-file (получаем postgresql://:@db:5432).
# Прод DOCKER_DATABASE_URL не задаёт — для него эта ветка не срабатывает.
if [ -n "$DOCKER_DATABASE_URL" ]; then
  DATABASE_URL="$DOCKER_DATABASE_URL"
  export DATABASE_URL
fi

echo "→ prisma migrate deploy (применяю миграции к БД)..."
npx prisma migrate deploy

echo "→ старт бота (node dist/src/main)..."
# exec — чтобы node стал PID 1 и корректно получал SIGTERM от docker (graceful shutdown,
# enableShutdownHooks в main.ts закроет соединения). Без exec сигнал уйдёт в sh, а не в node.
exec node dist/src/main
