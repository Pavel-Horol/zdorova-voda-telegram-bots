# DEPLOY.md — хостинг aqua-bot на своём VPS

Пошаговый runbook: от пустого сервера до работающего бота. Рассчитан на первый
самостоятельный деплой. Стек на сервере: **бот + Postgres в двух Docker-контейнерах**
на одном VPS, управляются через `docker compose`.

> Почему так, а не Kubernetes/облако: бот на **long polling** — входящий трафик,
> домен и webhook НЕ нужны, нужен просто процесс 24/7 + база. Один VPS + compose —
> это адекватный прод для проекта такого масштаба, а не «ненастоящий» хостинг.

---

## 0. Что понадобится
- VPS с Ubuntu 22.04/24.04 (Hetzner CX22 ~4–5 €/мес с запасом, или любой аналог).
  Минимум 1 vCPU / 2 GB RAM.
- Доступ по SSH (при создании сервера добавь свой SSH-ключ).
- Два **прод**-токена ботов от [@BotFather](https://t.me/BotFather) — отдельные,
  которые больше нигде не запущены (иначе `409 Conflict`, см. §8).
- `chat_id` супер-админа-диспетчера (узнать: напиши боту, глянь апдейт, или через
  [@userinfobot](https://t.me/userinfobot)).

---

## 1. Заходим на сервер
```bash
ssh root@ВАШ_IP
```

## 2. Ставим Docker (официальный скрипт)
```bash
curl -fsSL https://get.docker.com | sh
docker --version                # проверка: должна быть версия
docker compose version          # compose v2 идёт в комплекте
```

## 3. (Рекомендуется) отдельный пользователь вместо root
```bash
adduser deploy
usermod -aG docker deploy       # чтобы docker без sudo
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # перенести SSH-ключ
# дальше заходим уже как deploy:
#   ssh deploy@ВАШ_IP
```

## 4. Забираем код
```bash
cd ~
git clone git@github.com:Pavel-Horol/zdorova-voda-telegram-bots.git
cd zdorova-voda-telegram-bots
git checkout master             # или та ветка, которую деплоите
```
> ⚠️ Каталог НЕ переименовывать: путь `~/zdorova-voda-telegram-bots` захардкожен в
> job `deploy` (`.github/workflows/ci.yml`). Другое имя — и автовыкатка упадёт на `cd`.

> Приватный репозиторий? Настрой [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
> (ключ генерится на сервере, публичная часть — в Settings → Deploy keys, без write access).
> Если ключ назван не дефолтно (`id_ed25519`), пропиши его в `~/.ssh/config` для
> `Host github.com` — иначе ssh его не предложит и клон упадёт с `Permission denied (publickey)`.

## 5. Заполняем секреты
```bash
cp .env.production.example .env
nano .env
```
Заполни в `.env`:
- `POSTGRES_PASSWORD` — придумай надёжный (НЕ `aqua`).
- `CLIENT_BOT_TOKEN`, `DISPATCHER_BOT_TOKEN` — прод-токены.
- `DISPATCHER_CHAT_ID` — id супер-админа.
- `SUPPORT_PHONE` — реальный номер (без него бот НЕ стартует).

`DATABASE_URL` задавать НЕ нужно — его собирает `docker-compose.prod.yml` из
`POSTGRES_*` (хост базы внутри сети — `db`). Файл `.env` в `.gitignore`, в репозиторий
не попадёт.

## 6. Запускаем
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
Что произойдёт:
1. Соберётся прод-образ (multi-stage: генерация Prisma-клиента → `nest build`).
2. Поднимется Postgres, дождётся healthcheck.
3. Контейнер бота на старте прогонит `prisma migrate deploy` (накатит схему), затем
   запустит `node dist/src/main`.

## 7. Проверяем, что живой
```bash
docker compose -f docker-compose.prod.yml ps          # оба сервиса Up
docker compose -f docker-compose.prod.yml logs -f app # логи бота
```
В логах должно быть `Nest application successfully started` и НЕ должно быть
`401 Unauthorized` (401 = неверный токен). Затем напиши боту в Telegram — он ответит.
`Ctrl+C` выходит из просмотра логов (контейнер продолжает работать).

---

## 8. ⚠️ Единственный инстанс на токен (важно!)
Telegram разрешает **один** polling-процесс на токен. Второй даёт `409 Conflict` и
боты начинают «моргать». Отсюда правила:
- Эти прод-токены не запускай локально/на другом сервере одновременно.
- При обновлении (см. §9) `compose up` пересоздаёт контейнер: старый гасится ДО старта
  нового — короткий (секунды) даунтайг вместо наложения. Это норма, не бойся.

---

## 9. Обновление (выкатка нового кода)
```bash
cd ~/zdorova-voda-telegram-bots
git pull
docker compose -f docker-compose.prod.yml up -d --build
```
Compose пересоберёт образ, пересоздаст только изменившиеся контейнеры. Миграции
накатятся автоматически на старте. Postgres не трогается — данные на месте.

## 10. Откат
```bash
git checkout <предыдущий_коммит_или_тег>
docker compose -f docker-compose.prod.yml up -d --build
```
> ⚠️ Откат кода НЕ откатывает уже применённые миграции БД. Ломающие миграции пиши
> совместимыми (expand/contract), либо готовь обратную миграцию отдельно.

---

## 11. Бэкапы базы (сделай СРАЗУ, не потом)
Разовый дамп:
```bash
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U aqua aqua | gzip > ~/aqua-backup-$(date +%F).sql.gz
```
Автобэкап раз в сутки через cron. Сначала создай каталог (иначе cron будет молча
падать на редиректе): `mkdir -p /home/deploy/backups`. Затем `crontab -e`:
```
0 3 * * * cd /home/deploy/zdorova-voda-telegram-bots && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U aqua aqua | gzip > /home/deploy/backups/aqua-$(date +\%F).sql.gz
```
Восстановление:
```bash
gunzip -c ~/aqua-backup-2026-07-16.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U aqua -d aqua
```
> Данные лежат в Docker volume `pgdata` и переживают пересборку контейнеров. Но volume
> НЕ защищает от «снёс сервер» — держи дампы вне VPS (скачивай `scp`, или лей в S3).

---

## 12. Полезные команды
```bash
docker compose -f docker-compose.prod.yml logs -f app     # логи бота
docker compose -f docker-compose.prod.yml restart app     # рестарт только бота
docker compose -f docker-compose.prod.yml down            # остановить всё (данные целы)
docker compose -f docker-compose.prod.yml down -v         # ⚠️ снести ВМЕСТЕ с базой
docker system prune -f                                    # почистить мусор образов
```

---

## 13. CI/CD (автовыкатка) — настроено

Job `deploy` в `.github/workflows/ci.yml`: на push в `master`, после зелёного
quality-gate, GitHub Actions заходит на VPS по SSH и выполняет
`git reset --hard origin/master && docker compose -f docker-compose.prod.yml up -d --build`.
Ручная выкатка (§9) остаётся запасным вариантом.

Как устроен доступ:

- На сервере в `~/.ssh/authorized_keys` юзера `deploy` лежит **публичный** ключ
  `github-actions-aqua-bot` (отдельная пара, не личный ключ).
- В секретах репозитория (Settings → Secrets → Actions): `SSH_HOST` (IP),
  `SSH_USER` (`deploy`), `SSH_KEY` (**приватный** ключ той же пары).
- Отозвать доступ CI: удалить строку ключа из `authorized_keys` на сервере.

Путь репозитория на сервере: `~/zdorova-voda-telegram-bots` (захардкожен в job).
Прод-чекаут обновляется через `git reset --hard origin/master` — локальные правки
кода на сервере будут затёрты (это фича: сервер — точная копия master; `.env` не
в git, его reset не трогает).

---

## Заметки по безопасности (по желанию, для харденинга)
- Включи firewall: `ufw allow OpenSSH && ufw enable` (порт БД наружу не открыт —
  в compose он привязан к `127.0.0.1`).
- Отключи SSH по паролю, оставь только ключи.
- Контейнер бота сейчас работает от root внутри изоляции — для харденинга можно добавить
  непривилегированного пользователя в `Dockerfile.prod` (`USER node`).
