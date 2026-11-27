# tickturn

Русский · [English](#english)

Мод для [Claude Code](https://claude.com/claude-code), который показывает, сколько времени, токенов и денег Claude потратил на каждый запрос и на всю сессию.

Сайт: https://kotovdima1c.github.io/tickturn/

![Полоса над полем ввода с живым отсчётом и панель истории](docs/screenshots/mock-running.png)

- **Полоса над полем ввода** — живой таймер, пока ход идёт (`⏱ Идёт: 0:42 · Сессия: 4:22 · запросов: 7 · токенов: 1.2M · $0.84 · Сегодня: $3.42`), и время последнего хода в покое.
- **Панель истории** (`/time` или кнопка **История**) — все запросы сессии с токенами, стоимостью, длительностью и итогом; под итогом — разбивка токенов: ввод, вывод, чтение и запись кэша. История сохраняется на диск и возвращается после перезапуска, `--resume` и обновления мода.
- **Токены** — все четыре счётчика API (ввод, вывод, кэш: чтение и запись), вместе с субагентами хода. **Стоимость** — на сколько выросла стоимость сессии (как в `/cost`) за время хода; где движок её не ведёт, сумма не показывается.
- **Статистика по дням** — мод копит по всем сессиям на компьютере деньги, число запросов и время работы за каждый день. В полосе видно `Сегодня: $3.42`, в панели — «Сегодня» и «Этот месяц», а полная история по дням и месяцам лежит в файле `~/.claude/tickturn/costs.md`.
- Прерванные ходы помечаются `(прервано)`, завершившиеся ошибкой — `(ошибка)`. `/clear` начинает новую историю, прежняя остаётся в файле.

Работает в терминале и в десктопном приложении Claude. Язык интерфейса подбирается по языку системы: русский или английский.

| В покое | Панель истории |
| --- | --- |
| ![Полоса после завершения хода](docs/screenshots/mock-idle-band.png) | ![Панель «Время по запросам»](docs/screenshots/mock-idle-pane.png) |

## Установка

В Claude Code (в терминале или в поле ввода десктопного приложения):

```
/plugin marketplace add KotovDima1C/tickturn
/plugin install tickturn@tickturn
```

Выберите область **user** — тогда мод загрузится во всех проектах. Перезапустите Claude Code.

### Из локальной папки

```bash
claude plugin marketplace add /path/to/tickturn
claude plugin install tickturn@tickturn
```

Или только на одну сессию:

```bash
claude --plugin-dir /path/to/tickturn
```

## Язык

По умолчанию (`auto`) мод рисует подписи по-русски, если язык системы русский, иначе по-английски. Язык системы читается из переменных `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` (Linux, macOS), а без них — из локали окружения (Windows: региональный формат).

Переопределить можно в настройке мода `tickturn.language` (`/config` → tickturn → Language: `auto`, `ru`, `en`) или в `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "tickturn": { "options": { "language": "en" } } } }
```

## Статистика по дням

Мод считает дни по истории запросов всех сессий: после каждого запроса и при старте сессии он складывает стоимость, время и число запросов по дням и пересобирает отчёт:

| День       | Сумма  | Запросов | Время   |
| ---------- | ------ | -------- | ------- |
| 2026-11-20 | $3.42  | 18       | 0:45:10 |
| 2026-11-19 | $11.07 | 52       | 2:13:48 |

Ниже в файле — такая же таблица по месяцам. Отчёт лежит в `~/.claude/tickturn/costs.md`; другой путь задаётся настройкой `tickturn.reportPath` (`/config` → tickturn → Report file) или в `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "tickturn": { "options": { "reportPath": "~/notes/claude-costs.md" } } } }
```

Что стоит знать:

- Сумма — оценка по тарифам API, та же, что показывает `/cost`; на подписке это не реальное списание.
- День — местная дата окончания запроса. Время — сколько Claude работал над запросами, а не сколько была открыта сессия.
- Учёт идёт с момента установки версии 0.4.0 и только на этом компьютере.
- «Сегодня» считается и при старте сессии, а не только после её первого запроса.
- Траты соседних сессий появятся здесь после следующего своего запроса.
- Данные лежат в `~/.claude/tickturn/history/`: по файлу на сессию, `<id сессии>.json`. В нём запросы с текстом (первые 100 символов), временем окончания, длительностью, токенами и стоимостью. Других файлов с данными нет, отчёт `costs.md` собирается из этих.
- Версии 0.4.0 и 0.5.0 хранили суммы по дням в `sessions/<месяц>/`. Перенести их в историю: `python tools/migrate_legacy.py` (только сравнить) и `python tools/migrate_legacy.py --apply`. Скрипт восстанавливает запросы каждой такой сессии из логов Claude Code (`~/.claude/projects/`), цены — по тарифам API; старые папки переносит в `legacy/`. Так же он чинит сессии, которые писало окно, ещё не перезапущенное после обновления на 0.6. Повторный запуск безопасен. Запускать после того, как все окна Claude Code перезапущены.

## Как это работает

Мод — это модуль хуков (`hooks/register.tsx`):

- `turn.start` / `turn.complete` — измеряют каждый ход главного цикла (`durationMs` от движка); ходы субагентов отдельно не считаются, но их токены входят в ход, внутри которого они шли.
- `$.session.usage()` — стоимость сессии в начале и в конце хода.
- `ui.render` на `AbovePrompt` и `Pane` — рисуют полосу и историю.
- `$.fs` — файл истории своей сессии, чтение файлов остальных и отчёт; `$.session.id()` — имя файла сессии.
- `$.env.get` и `Intl` — определяют язык один раз при загрузке.
- Состояние живёт в `$.state` (`types/index.d.ts` — его контракт) и переживает горячую перезагрузку модуля в пределах сессии. После каждого хода история пишется в `history/<id>.json`, а при старте сессии с пустой памятью читается обратно (кроме старта после `/clear`).

## Разработка

```bash
claude plugin validate .
claude plugin test .
```

Проверка типов — `tsc -p .` после того, как движок положит типы в `.claude-plugin/types/` (он делает это при первой загрузке).

Сценарии ручной проверки — в [docs/test-prompts.md](docs/test-prompts.md).

## Лицензия

MIT

---

# English

[Русский](#tickturn) · English

A [Claude Code](https://claude.com/claude-code) mod that shows how much time, how many tokens and how much money Claude spent on each request and on the whole session.

Website (in Russian): https://kotovdima1c.github.io/tickturn/

![Band above the prompt with a live timer and the history pane](docs/screenshots/mock-running-en.png)

- **Band above the prompt** — a live timer while a turn runs (`⏱ Running: 0:42 · Session: 4:22 · requests: 7 · tokens: 1.2M · $0.84 · Today: $3.42`), the last turn's time when idle.
- **History pane** (`/time` or the **History** button) — every request of the session with its tokens, cost, duration and the total; under the total, the tokens broken down into input, output, cache read and cache write. The history is saved to disk and comes back after a restart, `--resume` or a mod update.
- **Tokens** are all four API counts (input, output, cache read and write), the turn's subagents included. **Cost** is how much the session cost (as `/cost` totals it) grew during the turn; where the engine keeps no cost ledger, no amount is shown.
- **Daily statistics** — the mod adds up money, requests and working time for each day across every session on the computer. The band shows `Today: $3.42`, the pane shows “Today” and “This month”, and the full history by day and month is kept in `~/.claude/tickturn/costs.md`.
- Interrupted turns are marked `(interrupted)`, failed ones `(error)`. `/clear` starts a new history; the old one stays in its file.

Works in the terminal and in the Claude desktop app. The UI follows the system language: Russian or English.

| Idle | History pane |
| --- | --- |
| ![Band after a turn finished](docs/screenshots/mock-idle-en-band.png) | ![The history pane](docs/screenshots/mock-idle-en-pane.png) |

## Install

In Claude Code (in a terminal or in the desktop app's prompt):

```
/plugin marketplace add KotovDima1C/tickturn
/plugin install tickturn@tickturn
```

Pick the **user** scope so the mod loads in every project, then restart Claude Code.

### From a local folder

```bash
claude plugin marketplace add /path/to/tickturn
claude plugin install tickturn@tickturn
```

Or for one session only:

```bash
claude --plugin-dir /path/to/tickturn
```

## Language

By default (`auto`) the labels are Russian when the system language is Russian and English otherwise. The system language is read from `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` (Linux, macOS); with none set (Windows) from the environment's locale, the regional format.

Override it in the mod's `tickturn.language` setting (`/config` → tickturn → Language: `auto`, `ru`, `en`) or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "tickturn": { "options": { "language": "en" } } } }
```

## Daily statistics

The mod counts days from every session's request history: after each request and at session start it sums cost, time and requests by day and rebuilds the report:

| Day        | Amount | Requests | Time    |
| ---------- | ------ | -------- | ------- |
| 2026-11-20 | $3.42  | 18       | 0:45:10 |
| 2026-11-19 | $11.07 | 52       | 2:13:48 |

The same table by month follows in the file. The report is `~/.claude/tickturn/costs.md`; name another path in the `tickturn.reportPath` setting (`/config` → tickturn → Report file) or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "tickturn": { "options": { "reportPath": "~/notes/claude-costs.md" } } } }
```

Worth knowing:

- The amount is an estimate at API prices, the one `/cost` shows; on a subscription it is not what you were charged.
- The day is the local date a request finished on. The time is how long Claude worked on requests, not how long the session stayed open.
- Counting starts when version 0.4.0 is installed, and covers this computer only.
- “Today” is counted at session start too, not only after the session's first request.
- What other sessions spend appears after this session's next request.
- The data is in `~/.claude/tickturn/history/`: a file per session, `<session id>.json`, with its requests: text (the first 100 characters), end time, duration, tokens and cost. There are no other data files; the `costs.md` report is built from these.
- Versions 0.4.0 and 0.5.0 kept day totals under `sessions/<month>/`. To move them into the history: `python tools/migrate_legacy.py` (compare only), then `python tools/migrate_legacy.py --apply`. The script rebuilds each such session's requests from Claude Code's transcripts (`~/.claude/projects/`), priced at API rates, and moves the old folders to `legacy/`. It also repairs sessions written by a window not yet restarted after the update to 0.6. Running it again is safe; run it once every Claude Code window has been restarted.

## How it works

The mod is a hooks module (`hooks/register.tsx`):

- `turn.start` / `turn.complete` — measure each main-loop turn (`durationMs` from the engine); subagent turns are not counted separately, but their tokens count toward the turn they ran in.
- `$.session.usage()` — the session cost at the start and the end of each turn.
- `ui.render` on `AbovePrompt` and `Pane` — draw the band and the history.
- `$.fs` — the session's own history file, the other sessions' files and the report; `$.session.id()` names the session's file.
- `$.env.get` and `Intl` — pick the language once at load.
- State lives in `$.state` (`types/index.d.ts` is its contract) and survives hot reloads of the module within a session. After every turn the history is written to `history/<id>.json`, and a session that starts with nothing in memory reads it back (except a start after `/clear`).

## Development

```bash
claude plugin validate .
claude plugin test .
```

Type-check with `tsc -p .` once the engine has laid the types into `.claude-plugin/types/` (it does so on the first load).

Manual test scenarios: [docs/test-prompts.md](docs/test-prompts.md) (in Russian).

## License

MIT
