# Release notes

## 0.4.0 — 2026-10-09

### Added

- Learn mode, off by default: `/route learn on`. Cache rewrites, an expensive model doing most of a prompt, context growing toward auto-compact, compaction and subagent-heavy prompts each become a lesson with the measured numbers: a toast when it happens (at most one per turn, once an hour per topic, three times per topic) and a **Learn** pane that explains each concept the first times and lists the facts. The band shows **Learn ●N** while lessons are unread.

## 0.3.2 — 2026-10-09

### Changed

- Stats is easier to scan: today, 7 days and all-time totals sit side by side, each command has a bar comparing its average cost to the priciest one, models are colour-coded, and each expensive prompt shows its date in its own column with cache rewrites on their own line.

## 0.3.1 — 2026-10-09

### Fixed

- Every hook that passes an event on now fails open explicitly: if the router's own code throws, the prompt, command, spawn, compaction or plan-mode tool call goes on as if the router weren't there. `claude plugin validate` lists them as gating hooks with `.catch`.

## 0.3.0 — 2026-10-09

### Fixed

- The cold-send guard holds only what you type. A task notification, scheduled trigger or peer message arriving on a cold cache used to be dropped with nobody to resend it.
- Two open sessions no longer overwrite each other's Stats history or settings: each save starts from what is stored.
- A failed read of the stored settings or history no longer saves defaults over them.
- Apply in the `/route` pane no longer turns routing back on after `/route off`.
- A `/route` change no longer reports failure when only the status refresh after it failed.
- A background subagent that keeps running after its prompt is charged to that prompt in Stats, not to whichever prompt is running when it finishes.
- An agent the router can't identify, such as the engine's own compaction or memory fork, is no longer given the workflow route's model while a workflow agent is starting. It keeps the engine's model, and its cost shows as Engine.

### Added

- The cold-send guard also holds slash commands that reach the model: user commands and MCP prompts always, skills once they have been seen to start a model turn.

## 0.2.0 — 2026-10-09

### Changed

- **A fresh install changes no model.** The default is the new `inherit` preset: costs, the band and the cold-send guard work, but routing starts only when you pick a preset (`/route preset mine`) or set a route. Saved settings carry over on update, and an older install that never saved its settings keeps routing as `mine`.
- **Apply in the `/route` pane takes only the routing** (on/off, preset, routes) from the draft, so a TTL, guard or prompt-text change made by command while the pane was open is kept.
- `/route set` checks the route name and keeps `auto` effort to `main` and `plan`.
- Commands that change settings run only when you type them, not from a peer session, channel or trigger. Opening a pane works from anywhere.

### Added

- **Cold-send guard.** When the prompt cache has expired over 50k+ tokens of context, the next message is dropped once with what re-sending it costs, priced on the model the turn is routed to. Send it again to pay it. `/route guard refuse|warn|off`.
- **Cache rewrites in the cost panes.** Requests that rebuilt the cache, because it expired or the route changed model or effort, are shown in **Last** and counted in **Stats**. The band shows `cold $x` once the cache is cold.
- `/route stats clear` deletes the saved prompt history.
- `/route stats text off` stops keeping prompt text in Stats and removes text already kept; `on` turns it back on (the default).
- README section on what the mod sees, keeps and sends.

### Fixed

- A malformed or older stored config or history no longer breaks every request: invalid entries are dropped on load.
- `/route preset constructor` and similar names no longer wipe the routes.
- Bookkeeping errors (saving history, refreshing status) never fail the request being counted.
- Text from agents, MCP servers and memory-file paths is stripped of terminal control characters before display.

### Internal

- Status refreshes only after main-loop requests and skips unchanged updates; history saves don't block the next prompt.
- `hooks/register.tsx` keeps the hooks and everything that touches engine state; the panes and band are pure views in `hooks/ui/`.

## 0.1.0 — 2026-10-08

First release.

- Model and effort per route: `main`, `plan`, and each subagent type, with presets (`mine`, `balanced`, `frugal`, `max`) and a cache-aware `auto` effort.
- Band above the prompt: active route, prompt-cache hit rate and warm timer, context use, last prompt's cost, 5-hour and 7-day limits.
- Panes: `/route` (routes, draft with cost estimate, spend per route), Last prompt cost, Context breakdown, Stats (commands by average cost, most expensive prompts, kept across sessions).
- `/route` commands: `stats`, `context`, `last`, `preset`, `set`, `on`/`off`, `band`, `ttl`.
