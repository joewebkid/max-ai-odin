# MAX bot -> g4f / codex-lb

Бот для мессенджера MAX, который принимает текстовые сообщения и умеет отправлять их либо на ваш `g4f`-сервер, либо в `codex-lb` по API ключу.

## Что уже сделано

- Подключена официальная библиотека MAX: `@maxhub/max-bot-api`
- Добавлен клиент для `g4f` и `codex-lb`
- Поддерживаются три режима API:
  - `backend-api` -> `POST /backend-api/v2/conversation`
  - `openai` -> `POST /v1/chat/completions`
  - `cryptosmi` -> `POST /generate` на кастомный сервер
- Для `g4f` и `codex-lb` хранится отдельный контекст диалога
- Есть команды `/start`, `/help`, `/mode`, `/tariff`, `/reset`
- Режим можно переключать через inline-меню прямо в чате
- Бот сохраняет метрики по пользователям, чатам, backend и токенам
- Есть отдельный web-admin процесс для просмотра статистики и управления лимитами
- Длинные ответы режутся на части под лимит MAX
- Для `codex-lb` можно держать одну живую server-side сессию через `responses` API

## Настройка

Отредактируйте файл `.env`.

### Минимальная конфигурация для двух режимов сразу

```env
DEFAULT_BACKEND=g4f
TOKEN_CYCLE_DAYS=30
DEFAULT_TARIFF_ID=starter
TARIFFS_JSON=[{"id":"starter","name":"Старт","description":"Для редких обращений и тестов.","priceText":"0 ₽","monthlyTokens":50000,"isPublic":true},{"id":"plus","name":"Плюс","description":"Для ежедневной работы с ботом.","priceText":"990 ₽","monthlyTokens":300000,"isPublic":true},{"id":"pro","name":"Про","description":"Для активного использования и длинных диалогов.","priceText":"3 990 ₽","monthlyTokens":1500000,"isPublic":true}]

G4F_BASE_URL=http://127.0.0.1:1337
G4F_API_MODE=openai
G4F_MODEL=gpt-4o-mini

CODEX_BASE_URL=https://codex-lb.example.com
CODEX_API_MODE=openai
CODEX_API_KEY=sk-clb-...
CODEX_MODEL=gpt-5.3-codex
CODEX_USE_RESPONSES=true
CODEX_SESSION_FILE=data/codex-sessions.json
```

### Если ваш `g4f`-сервер использует backend API

```env
G4F_BASE_URL=https://your-server.example.com
G4F_API_MODE=backend-api
G4F_MODEL=gpt-4o-mini
G4F_PROVIDER=
G4F_API_KEY=
```

Можно указывать и URL вида `https://your-server.example.com/backend-api/v2`:
бот сам добавит `/conversation`.

Для серверов `g4f`, которые отдают ответ как SSE-поток, бот тоже подходит: служебные `event:`-строки отфильтровываются, и пользователю возвращается только текст модели.

### Если ваш `g4f`-сервер использует OpenAI-compatible API

```env
G4F_BASE_URL=https://your-server.example.com
G4F_API_MODE=openai
G4F_MODEL=gpt-4o-mini
G4F_API_KEY=
```

Можно указывать и URL вида `https://your-server.example.com/v1`:
бот сам добавит `/chat/completions`.

### Если нужно работать через локальный `g4f` на сервере

```env
G4F_BASE_URL=http://127.0.0.1:1337
G4F_API_MODE=openai
G4F_MODEL=gpt-4o-mini
```

Этот вариант подходит именно для запуска бота на том же сервере, где поднят `g4f`.

### Если нужно работать как `cryptosmi`

```env
G4F_BASE_URL=https://ai2m.lembos.ru
G4F_API_MODE=cryptosmi
G4F_MODEL=gpt://{folder_id}/yandexgpt-lite/latest
G4F_GENERATE_PATH=/api/text/generate
```

В `cryptosmi`-режиме бот отправляет не массив `messages`, а один собранный текстовый промт с историей диалога, потому что серверный endpoint ожидает поле `prompt`.

## Запуск

```bash
npm install
npm start
npm run start:admin
```

## Команды

- `/start` - приветствие и сброс текущего контекста
- `/help` - короткая справка
- `/mode` - открыть меню переключения между `g4f` и `codex-lb`
- `/tariff` - открыть меню тарифов и посмотреть остаток токенов
- `/reset` - очистить историю диалога для обоих режимов

Если включен `CODEX_USE_RESPONSES=true`, то для `codex-lb` бот использует `POST /v1/responses` и хранит `previous_response_id` по каждому чату в `CODEX_SESSION_FILE`. Это даёт настоящую continuity-сессию на стороне `codex-lb`, а не только локальную историю в памяти процесса.

## Админка

Админка показывает:

- кто пользовался ботом
- какие чаты его вызывают
- какой backend выбирают чаще
- сколько запросов прошло
- сколько токенов потрачено
- какой тариф стоит у пользователя
- сколько токенов осталось в текущем цикле
- ручное добавление и снятие токенов
- блокировка и разблокировка доступа
- ручной сброс цикла лимита
- последние запросы и ошибки

Переменные для неё:

```env
METRICS_FILE=data/bot-metrics.json
RECENT_REQUESTS_LIMIT=200
TOKEN_CYCLE_DAYS=30
DEFAULT_TARIFF_ID=starter
TARIFFS_JSON=[{"id":"starter","name":"Старт","description":"Для редких обращений и тестов.","priceText":"0 ₽","monthlyTokens":50000,"isPublic":true},{"id":"plus","name":"Плюс","description":"Для ежедневной работы с ботом.","priceText":"990 ₽","monthlyTokens":300000,"isPublic":true},{"id":"pro","name":"Про","description":"Для активного использования и длинных диалогов.","priceText":"3 990 ₽","monthlyTokens":1500000,"isPublic":true}]
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3477
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_me
```

По умолчанию цикл лимита длится `30` дней. Пользователь может переключать публичные тарифы прямо в боте через `/tariff`, а администратор может в админке менять тариф, добавлять токены, убирать токены, блокировать доступ и вручную сбрасывать цикл.

## Что важно

- В `.env` уже должен быть корректный `MAX_BOT_TOKEN`
- Нужно обязательно заполнить `G4F_BASE_URL` и `CODEX_BASE_URL`
- Если на вашем сервере включена защита `g4f-api-key`, укажите `G4F_API_KEY`
- Для `codex-lb` укажите `CODEX_API_KEY`
- Для админки обязательно задайте `ADMIN_PASSWORD`
- История и выбранный режим хранятся только в памяти процесса и очищаются после перезапуска
- Метрики, тарифы, лимиты и ручные корректировки хранятся в `METRICS_FILE`
