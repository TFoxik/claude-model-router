# model-router

A Claude Code mod that picks the model and effort per kind of work: plan mode, normal work, and each subagent type. It includes a cache-aware auto mode and per-route cost tracking.

![Two-row band above the prompt and today's spend below it](docs/band-and-footer.svg)

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install model-router --marketplace TFoxik/claude-model-router
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session).

## What you get

- **Band above the prompt**, two rows:
  - Routing: the route the last request used, the configured plan / main / sub routes, the session's estimated total, and **Routes** / **Hide** buttons.
  - Health: `cache 96% 42m  ·  context 31%  ·  last $0.05  ·  5h 38%  ·  7d 12%`, coloured by health.
    - `cache` prompt-cache hit rate of the last main-loop request, and minutes until the cache goes `cold`. Once cold over a big context it shows what the next send would cost to re-write, for example `cold $1.60`.
    - `context` context used. Green until 60% of the way to auto-compaction, amber to 85%, red after. Click the word for a breakdown: categories, MCP servers, memory files, distance to auto-compact.
    - `last` cost of your whole last prompt (main loop plus every subagent it started), growing live. Click it for the per-agent breakdown.
    - `5h` / `7d` how much of the 5-hour and 7-day limits is used.
- **Footer**: `▤ today $12.30`, what you've spent today. Click it for **Stats**, kept across sessions for this repo or all repos: commands ranked by average cost per run (`/simplify`, `/code-review`, plain prompts…) and your most expensive prompts, each with the models and effort levels it used and what each cost, so you learn over time which calls are costly.
- **Cold-send guard**: when the cache has gone cold over 50k+ tokens of context, your next message is dropped once with its price, worked out for the model the next turn is routed to: `the prompt cache went cold 1h12m ago. This send re-writes ~200k tokens on Opus 5.5 = $1.60 (warm would be $0.04)`. Send it again to pay it, or `/clear`. `/route guard warn` only shows the price; `/route guard off` turns it off.
- **Cache rewrites in the cost panes**: a request that rebuilt the cache, because it went cold or because the route changed model or effort, is marked in **Last** and counted in **Stats** (`· 3 cache rewrites $4.20`), with what it cost above a warm read.
- **`/route` pane**: model and effort per route, presets, and a per-route spend table. Edits stay a draft until you press **Apply**. The draft shows the per-turn cost change, the one-off cache rewrite cost, the plan-mode toggle cost and the payback.

## Commands

| Command | Effect |
|---|---|
| `/route` | Open the pane |
| `/route stats` / `context` / `last` | Open the Stats, Context or Last prompt cost pane (handy in the terminal) |
| `/route preset mine\|balanced\|frugal\|max` | Apply a preset |
| `/route set <route> <model> [effort]` | Set one route now, for example `/route set sub:Explore haiku low` |
| `/route on` / `/route off` | Enable or disable routing |
| `/route band on\|off` | Show or hide the band |
| `/route guard refuse\|warn\|off` | What a send onto a cold cache does (default `refuse`: dropped once with its price) |
| `/route ttl 5\|60` | Prompt-cache lifetime used for the warm/cold timer (default 60) |

Routes: `main`, `plan`, `sub:*`, `sub:Explore`, `sub:Plan`, `sub:general-purpose`, `sub:<any-agent-type>`, `workflow`, `teammate`.
Models: `opus`, `sonnet`, `haiku`, `fable`, `inherit`. Efforts: `low` through `max`, `auto` (main and plan only), `inherit`.

## Notes

- Prompt caches are tied to one model and effort. Changing the route the main loop is on rewrites the cache once. The pane shows that cost before you apply.
- Subagents start with a fresh context, so routing them to cheaper models costs nothing up front.
- Forks always inherit the parent's model.
- The guard prices a cold send from the band's clock, not a server check. It doesn't keep the cache warm while you're away; [cache-tax](https://github.com/karanb192/cache-tax) does that with idle pings. With both installed, two guards fire on every cold send, so run `/route guard off` to leave it to cache-tax.
- Prices are hard-coded in `hooks/routes.ts` (as of 2026-10-06). Cache writes are priced by the `/route ttl` setting: 2× input for the 1-hour cache (default), 1.25× for the 5-minute one. The costs shown are estimates.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```
