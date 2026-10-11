# model-router

A Claude Code mod that picks the model and effort for each kind of work, and shows what those choices cost.

Plan mode, normal work and each subagent type can run on a different model: Opus for planning, Sonnet for edits, Haiku for searches. The mod tracks prompt-cache health and spend as you go, stops a send that would re-write a cold cache, and can explain where your money went with your own numbers.

![Three-line band above the prompt: routes, then cache and cost, then a right-aligned row of buttons with next /clear highlighted, and today's spend below it](docs/band-and-footer.svg)

The **[field guide](https://tfoxik.github.io/claude-model-router/)** walks through every part of the screen it adds, with annotated pictures.

## What it does

- **Routes models per kind of work.** Set a model and effort for `main`, `plan`, each subagent type (`sub:Explore`, `sub:Plan`, …), workflows and teammates, or pick a preset. The `/route` pane shows what a change costs per turn, the one-off cache rewrite it causes, and when it pays back, before you apply it.
- **Shows cost and cache health in a band above the prompt**: `cache 96% 42m · context 31% · last $0.05 · session $1.23 · 5h 38% · 7d 12%`. That's the cache hit rate and minutes until it goes cold, context used, the cost of your last prompt and of this session, and your 5-hour and 7-day limits. The band's last line has **Context** and **Cost** for a breakdown with tips on what to trim or reroute.
- **Says when to carry on, compact, clear or hand off.** When carrying on is not the best move, the band's last line shows a `next /clear`, `next /compact` or `next /handoff` button:
  - **Clear** after a commit or pull request over a sizeable context, once the cache has gone cold, once a plan is written to disk (implement it in a fresh context), or after two corrections in a row (start over with a better prompt).
  - **Hand off** instead of clearing after a commit or compacting when two or more todos or tasks are still open: a written handoff keeps the plan's detail, a summary does not. It names your `/handoff` skill when you have one.
  - **Compact** when auto-compact is close or the conversation fills most of the context.
  - The Context pane's tips give the reason in dollars, and suggest a subagent when reads and searches fill the main context.
  - It shows with learn mode on or off. `/route next off`, or the Routes pane's **Next-step advice** row, hides it.
- **Saves a handoff before the cache goes cold, if you want it to.** With `/route handoffs auto on`, when the cache is in its last minutes and work is still open, it asks Claude for a handoff while reading the context is still cheap and saves it under `~/.claude/handoffs/<repo>/`. Once per prompt; it never clears the session itself.
- **Keeps a list of handoffs.** `/route handoffs` lists the handoffs in `~/.claude/handoffs/<repo>/`, saved by auto-handoff or your own `/handoff`, each with its title and a line or two on what it is about (the first paragraph under its `## Goal`, or after the title). Each open one has **Resume** (fills the prompt with `resume from <path>`), **Done** and **Not relevant**. A handoff closes on its own when a newer one is saved in the same session, or when you send a prompt naming it; one left open for 14 days folds away as stale. The band shows `Handoffs ●N` when other sessions left handoffs open, until you open the pane. `/route handoffs off`, or the Routes pane's **Handoffs** row, turns the whole feature off: no count in the band and no auto-handoff. Files are never edited or deleted; to prune old ones: `find ~/.claude/handoffs -name '*.md' -mtime +30 -delete`.
- **Spots MCP servers and plugins you don't use.** It notes, per repo, which MCP servers and plugins are loaded and which get used. Once one has been loaded for two weeks and ten sessions without use in 30 days, the Context pane and `/route unused` name it with the setting that turns it off. The mod can't switch anything off itself:
  - **MCP servers** go off per repo in `/mcp`. When none of your connected claude.ai connectors is used, it also offers `"disableClaudeAiConnectors": true`.
  - **Plugins** get a ready-to-paste `enabledPlugins` block for the repo's `.claude/settings.local.json`, or `/plugin` when no repo uses them. A plugin listed covers its own MCP server.
  - Connectors you never signed in to aren't counted. A plugin's hooks can't be seen, so plugins with only hooks are never listed.
- **Shows where the money went, in one Cost pane.** Its tabs are **Last prompt** (each request and subagent, with tips), **Session** (spend per route) and **History**, kept across sessions: which commands cost most on average and your most expensive prompts, with the models each one used, for this repo or all repos. **Cost** in the band opens it on Last prompt; the footer's `▤ today $12.30` opens History.
- **Guards cold sends.** When the cache has expired over a big context, your next message is held once with its price: `This send re-writes ~200k tokens on Opus 5.5 = $1.60 (warm would be $0.04)`. Send it again to pay, or `/clear`.
- **Teaches, if you want it to.** Learn mode (off by default) explains each cache miss, model switch, growing context and expensive prompt with the real numbers, warns before the cache goes cold, and says why a commit is a good moment to `/clear`. The Learn pane also lists three habits no hook can spot: `/clear` between unrelated tasks, `/btw` for side questions, and Esc Esc to rewind. `/route away`, and the Context pane's **Before a break** box once the context is big, compare the cheapest ways to step away from a session.

![The /route pane: routing on, the live route, the preset and the route table, then every setting grouped at the bottom](docs/routes-pane.svg)

![A learn mode toast warning that the cache goes cold in 5 minutes, and the Learn pane explaining a cold cache rewrite with its cost](docs/learn.svg)

## Install

Needs Claude Code 2.1.287 or later (tested with 2.1.294). At the prompt of a terminal Claude Code session:

```
/plugin install model-router --marketplace TFoxik/claude-model-router
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Or from a shell:

```
claude plugin marketplace add TFoxik/claude-model-router
claude plugin install model-router@claude-model-router
```

A fresh install changes no model: it starts on the `inherit` preset, which only tracks costs. Run `/route preset mine`, or pick a preset in `/route`, to start routing. New to prompt caching? Turn on learn mode with `/route learn on`.

### Update

Claude Code doesn't auto-update third-party marketplaces unless you turn it on. Once, in `/plugin`: **Marketplaces** → `claude-model-router` → **Enable auto-update**. New sessions then pick up each release at startup; open ones need `/reload-plugins`.

To update by hand instead:

```
claude plugin marketplace update claude-model-router
claude plugin update model-router@claude-model-router
```

Then restart or run `/reload-plugins`. Saved settings carry over. See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Commands

| Command | Effect |
|---|---|
| `/route` | Open the Routes pane: routing on top, every setting below it |
| `/route preset inherit\|mine\|balanced\|frugal\|max` | Apply a preset (`inherit` changes no model, it only tracks) |
| `/route set <route> <model> [effort]` | Set one route, for example `/route set sub:Explore haiku low` |
| `/route on` / `off` | Enable or disable routing |
| `/route cost [last\|session\|history]` | Open the Cost pane, on a tab |
| `/route last` / `stats` / `context` | Open Cost on Last prompt, Cost on History, or the Context pane |
| `/route stats clear` | Delete the saved prompt history |
| `/route stats text on\|off` | Keep the first 120 characters of each prompt in Cost › History (default on); off also removes text already kept |
| `/route learn` / `learn on\|off` | Open the Learn pane / turn learn mode on or off (default off) |
| `/route learn mute\|unmute <topic>` | Silence a topic: `cold-rewrite`, `switch-rewrite`, `pricey-model`, `context-high`, `compacted`, `subagents`, `cache-expiring`, `plan-toggle`, `strategy`, `handoff`, `plan-ready`, `corrections`, `exploration`, `auto-handoff` |
| `/route next on\|off` | Show or hide the band's `next /clear`, `/compact` or `/handoff` and the Context pane's advice tip (default on) |
| `/route handoffs` / `handoffs on\|off` | Open the Handoffs pane: open handoffs to resume, mark done or not relevant / turn handoffs on or off: the band's count and auto-handoff (default on) |
| `/route handoffs auto on\|off` | Save a handoff while the cache is still warm, before it goes cold with work open (default off) |
| `/route away` | Before a break: the ways to step away, priced for this session; also in the Context pane |
| `/route unused` | MCP servers and plugins this repo has long left unused, and how to turn each off |
| `/route guard refuse\|warn\|off` | What a send onto a cold cache does (default `refuse`: held once with its price); also the Routes pane's **Cold-cache guard** row |
| `/route ttl 5\|60` | Prompt-cache lifetime for the warm/cold timer (default 60); also the Routes pane's **Cache lifetime** row |
| `/route band on\|off` | Show or hide the band; also the Routes pane's **Band** row. Routing works either way |

Routes: `main`, `plan`, `sub:*`, `sub:<agent-type>` (such as `sub:Explore`), `workflow`, `teammate`. Models: `opus`, `sonnet`, `haiku`, `fable`, `inherit`. Efforts: `low` through `max`, `auto` (main and plan only), `inherit`.

## Good to know

- **Switching the main loop's model or effort rewrites the cache once**, at 1.25-2× input over the whole context. The pane shows that cost before you apply. With plan and main routed differently, entering and leaving plan mode each pay it.
- **Rerouting subagents is free**: they start with a fresh context. Forks always inherit the parent's model.
- **Prices are estimates**, hard-coded in `hooks/routes.ts` (as of 2026-10-06). Model IDs are the Anthropic API's; on a provider that names models differently, turn routing off or set routes to `inherit`.
- **The guard works from the band's clock**, not a server check, and doesn't keep the cache warm while you're away.

## Overhead and privacy

- **No tokens added**: no system prompt or attachments. Toasts, the band and the panes stay in the UI.
- **Two optional model calls**, both off unless you pick them:
  - `auto` effort (presets `balanced` and `frugal`) sends the first 4,000 characters of each prompt you type to Haiku to classify it, about $0.0001 and a few hundred milliseconds. Fixed efforts make no call.
  - Auto-handoff (`/route handoffs auto on`) sends one prompt asking for a handoff, at most once per prompt, when the cache is about to go cold with work open. It is a normal turn: it reads the context at the warm cache price and pays for the handoff it writes.
- **Stored locally** in the plugin store, across repos: prompt history for Cost › History (the first 120 characters of each prompt, repo name, cost, models; last 2,000 prompts), learn mode lessons (numbers and model names, never prompt text; last 20 per topic), handoff records (path, title, a line or two of what it is about, status), and per repo which MCP servers and plugins were loaded and used (names, counts and dates, never tool arguments).
- **Files: only `~/.claude/handoffs/`.** The mod lists and reads the handoffs there and, with auto-handoff on, writes new ones. It never edits or deletes a file. It has no network or process access of its own; nothing leaves your machine except the model calls above, which go through Claude Code.
- **Settings change only when you type a command or use a pane control**, never from a peer session, channel or trigger. Opening a pane works from anywhere.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

To see the unused MCP server and plugin advice without two weeks of history, start a session with `MODEL_ROUTER_IDLE_DEV=1 claude --plugin-dir .`. After its first prompt, `/route unused` and the Context pane list whatever was loaded but not used in the last 30 days. Turn off an installed copy of the mod in `/plugin` while you do, or both copies load.

## License

MIT, see [LICENSE](LICENSE).
