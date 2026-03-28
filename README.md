# AgentNet

Агентская сеть для поиска людей, компаний и возможностей через Telegram.

## Архитектура

```
Telegram Bot (grammy)
    ↓
Bot handlers → Onboarding / Commands / Callbacks
    ↓
Agent Layer:
  - onboarding.js   — 6-фазное интервью (Claude Haiku)
  - matching.js     — embedding-поиск + scoring + ping generation
  - proxy.js        — прокси-диалог (4 режима) + temporal lock
    ↓
Queue Layer (BullMQ + Redis):
  - matching queue  — асинхронный поиск кандидатов
  - dialogue queue  — обработка ходов диалога
  - notify queue    — уведомления
    ↓
Database (Postgres + pgvector):
  - users, profiles, pings, dialogues, watchlist
```

## Быстрый старт

### 1. Переменные окружения

```bash
cp .env.example .env
# Заполни: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY
```

### 2. Локально через Docker

```bash
docker-compose up -d postgres redis
npm install
npm run migrate
npm run dev           # бот
npm run worker        # воркер очередей (в отдельном терминале)
```

### 3. Продакшн (Railway/Render)

1. Создай Postgres и Redis сервисы
2. Задай переменные окружения
3. Задеплой репозиторий
4. Запусти `npm run migrate` как one-off command
5. Запусти два сервиса: `npm start` и `npm run worker`

## Пользовательский сценарий

```
/start → онбординг (6 фаз, ~15 мин)
       → профиль готов

/match → поиск кандидатов
       → агент отправляет пинги от имени пользователя
       → получатели получают уведомление

/pings → список входящих пингов
       → [Принять] → начинается прокси-диалог
       → [Отклонить] → пинг закрывается

диалог → сообщения через агента-посредника
       → 4 режима: relay / rephrase / enrich / block
       → [Хочу контакт] → temporal lock
       → если оба подтвердили → хэндофф, обмен контактами
```

## Структура файлов

```
src/
  agent/
    onboarding.js   — интервью по фазам
    matching.js     — embedding + scoring + ping
    proxy.js        — прокси-диалог + temporal lock
  bot/
    telegram.js     — Telegram bot handlers
  db/
    postgres.js     — db connection + helpers
  queue/
    queues.js       — BullMQ queue definitions
    worker.js       — background job processors
  index.js          — entry point

scripts/
  schema.sql        — database schema
  migrate.js        — migration runner
```

## Расширение

**Добавить тип агента (компания/сервис):**
- Добавь `agent_type` в таблицу profiles
- Обнови scoring weights в matching.js
- Добавь отдельный онбординг для компаний

**Добавить веб-витрину:**
- Подними Express сервер (src/api/server.js)
- GET /agents/:id → публичный профиль агента
- Используй showcase_public из profiles

**Добавить репутацию:**
- Таблица reputation_events
- Обновляй после каждого успешного хэндоффа
- Взвешивай в scoring
