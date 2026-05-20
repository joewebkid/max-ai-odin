# MAX and Telegram bots -> Free / Chat GPT

Боты для MAX и Telegram, которые принимают сообщения и умеют отправлять их либо в бесплатный `g4f`-режим, либо в `codex-lb` по API ключу.

## Что уже сделано

- Подключена официальная библиотека MAX: `@maxhub/max-bot-api`
- Подключен Telegram Bot API через `grammy`
- Добавлен клиент для `g4f` и `codex-lb`
- Поддерживаются три режима API:
  - `backend-api` -> `POST /backend-api/v2/conversation`
  - `openai` -> `POST /v1/chat/completions`
  - `cryptosmi` -> `POST /generate` на кастомный сервер
- Для `Free` и `Chat GPT` хранится отдельный контекст диалога
- Есть команды `/start`, `/help`, `/mode`, `/tariff`, `/reset`
- Режим можно переключать через inline-меню прямо в чате
- Приватные режимы `Claude`, `Gemini` и `GigaChat` можно включить только для owner-аккаунтов через `PRIVATE_BACKEND_USER_IDS`
- Пользователь может оставить заявку на тариф через `/tariff`; прямое переключение тарифа в боте отключено
- Бот сохраняет метрики по пользователям, чатам, backend и токенам
- Есть отдельный web-admin процесс для просмотра статистики и управления лимитами
- Метрики и лимиты общие для MAX и Telegram, но пользователи хранятся раздельно по платформам
- Длинные ответы режутся на части под лимит MAX
- Для `codex-lb` можно держать одну живую server-side сессию через `responses` API
- Режим `Free` не списывает токены из пользовательской квоты, а `Chat GPT` списывает

## Настройка

Отредактируйте файл `.env`.

### Минимальная конфигурация для двух режимов сразу

```env
DEFAULT_BACKEND=chatgpt
TELEGRAM_BOT_TOKEN=123456:telegram_token
TELEGRAM_PROXY_URL=
PAYMENT_REQUEST_TELEGRAM_CHAT_ID=123456789
PRIVATE_BACKEND_USER_IDS=4976849,tg:user:248192426
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

ANTI_API_BASE_URL=http://127.0.0.1:8964
ANTI_API_CLAUDE_MODEL=route:claude
ANTI_API_GEMINI_MODEL=gemini-3.1-pro-high

GIGACHAT_AUTH_KEY=base64_client_id_client_secret
GIGACHAT_MODEL=GigaChat
GIGACHAT_SCOPE=GIGACHAT_API_PERS
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
npm run start:telegram
npm run start:admin
```

Если запускаете только Telegram-бота, достаточно `npm run start:telegram`. Для MAX по-прежнему используется `npm start`.

Если сервер напрямую не видит `api.telegram.org`, можно указать `TELEGRAM_PROXY_URL`, например `http://172.17.0.1:10809`. Тогда Telegram Bot API будет вызываться через HTTP proxy.

## Команды

- `/start` - приветствие и сброс текущего контекста
- `/help` - короткая справка
- `/mode` - открыть меню переключения между `Free` и `Chat GPT`; owner-аккаунтам дополнительно видны `Claude`, `Gemini` и `GigaChat`
- `/tariff` - посмотреть остаток токенов и оставить заявку на желаемый тариф
- `/reset` - очистить историю диалога для обоих режимов

Telegram-бот использует те же команды и ту же логику квот, что и MAX-бот. Контекст и тарифы считаются отдельно для каждого Telegram-пользователя, а в группах контекст ведётся отдельно для каждого участника внутри чата.

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
PAYMENT_REQUEST_TELEGRAM_CHAT_ID=123456789
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3477
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change_me
```

По умолчанию цикл лимита длится `30` дней. Пользователь может оставить заявку на публичный тариф прямо в боте через `/tariff`, а администратор вручную меняет тариф, добавляет токены, убирает токены, блокирует доступ и сбрасывает цикл в админке.

`PAYMENT_REQUEST_TELEGRAM_CHAT_ID` - один или несколько Telegram chat id через запятую, куда бот отправляет заявки на тарифы.

`PRIVATE_BACKEND_USER_IDS` - один или несколько user id через запятую, для которых показываются приватные режимы. Для MAX можно указывать обычный числовой id, например `4976849`; для Telegram используйте формат `tg:user:248192426`.

## Что важно

- В `.env` уже должен быть корректный `MAX_BOT_TOKEN`
- Для Telegram нужен `TELEGRAM_BOT_TOKEN`
- Если Telegram API недоступен напрямую, задайте `TELEGRAM_PROXY_URL`
- Нужно обязательно заполнить `G4F_BASE_URL` и `CODEX_BASE_URL`
- Если на вашем сервере включена защита `g4f-api-key`, укажите `G4F_API_KEY`
- Для `codex-lb` укажите `CODEX_API_KEY`
- Для админки обязательно задайте `ADMIN_PASSWORD`
- История и выбранный режим хранятся только в памяти процесса и очищаются после перезапуска
- Метрики, тарифы, лимиты и ручные корректировки хранятся в `METRICS_FILE`
