# Release notes

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
