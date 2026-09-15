# Bitrix24 CRM tools — Cloudflare Workers

Это НЕ Cloudflare Tunnel. Проект полностью размещается на Cloudflare Workers.
Локальный сервер, Tailscale, Dev Tunnel и LocaltoNet после переноса не нужны.

## Деплой через GitHub

1. Загрузите содержимое этой папки в корень GitHub-репозитория.
2. Cloudflare Dashboard -> Workers & Pages -> Create application.
3. Import a repository.
4. Выберите репозиторий.
5. Worker name должен быть `bitrix-crm-tools`
   (или измените `name` в `wrangler.jsonc` на выбранное имя).
6. Deploy command: `npm run deploy`
7. Сохранить и развернуть.

Cloudflare выдаст:
`https://bitrix-crm-tools.<ваш-subdomain>.workers.dev`

## Проверка

Откройте:
`https://...workers.dev/health.php`

Должно быть:
`{"ok":true,"service":"bitrix-crm-tools","platform":"cloudflare-workers",...}`

Потом на ПК с Bitrix24 Desktop:
`curl.exe -I https://...workers.dev/`

Должен быть обычный HTTP-ответ без schannel error и без warning/interstitial page.

## Bitrix24

Путь первоначальной установки:
`https://...workers.dev/install.php`

Путь обработчика:
`https://...workers.dev/index.php`

`install.php` удалит старые tunnel-URL и зарегистрирует:
- КП
- Тест-драйв
- Результат звонка
- Завершить звонок с результатом
- контроль ONCRMACTIVITYUPDATE

## Важно

- `Результат звонка` использует версию, которая показывает UI сразу и опрашивает CALL_CARD повторно, если CALL_ID приходит с задержкой.
- `Тест-драйв`, `КП` и `Завершить звонок` получают ID из `BX24.placement.info()`, поэтому PHP на сервере больше не нужен.
- `activity-guard.php` реализован непосредственно в Worker.
