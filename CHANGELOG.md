# Release notes

## 1.1.0 — 2026-10-11

### Added

- **What each handoff is about.** The Handoffs pane shows a dimmed line or two under each title: the first paragraph under the handoff's `## Goal`, or after its title, as plain text. Handoffs you already have get theirs on the next listing.

## 1.0.1 — 2026-10-11

### Changed

- **A tidier band.** The cache and cost line is plain text now, evenly spaced, and every button sits right-aligned on the band's last line: Handoffs, Learn, the `next /clear` advice (shown once, highlighted), then **Context**, **Last** and **Routes**. A desktop draws buttons as native controls with their own padding, so mixing them into the text lines made the spacing and left edge uneven.

## 1.0.0 — 2026-10-11

### Added

- **Handoffs on/off.** `/route handoffs on|off`, a **Turn on** line in the Handoffs pane and a **Handoffs** row in the Routes pane switch the whole feature: off hides the band's count and keeps auto-handoff from asking. Handoffs you save with `/handoff` are still listed. Auto-handoff now sits under it in the Routes pane.

### Changed

- **The band is always three lines.** The route line and the health row each get the full width, and Handoffs, Learn and Routes share the third line, so the band no longer grows to four lines when both counts show. `handoffs ●N` is now `Handoffs ●N`.
- **Hide moved off the band**, away from the buttons you click every day: hide or show the band from the Routes pane's **Band** row, or with `/route band off|on`.

## 0.9.1 — 2026-10-11

### Changed

- **Handoffs pane, under the hood.** Fewer store writes and file reads: a refresh that finds nothing new saves nothing, folders and titles are read in parallel, and session start lists only the current repo's handoffs. Handoff titles and repo names drop control characters, as history and lessons already do.

## 0.9.0 — 2026-10-11

### Added

- **Handoffs pane.** `/route handoffs` lists this repo's handoffs with Resume, Done and Not relevant. Handoffs close on their own when superseded by a newer one from the same session or resumed by a prompt naming them, and fold away as stale after 14 days. The band shows `handoffs ●N` for handoffs other sessions left open, until you open the pane.

### Fixed

- **Panes come to the front.** Clicking a band or footer button for a pane that is already open behind another, such as **today** for Stats, now brings it to the front.

## 0.8.6 — 2026-10-11

### Fixed

- **Auto-handoff.** The handoff is now saved. Before, Claude was asked for it but the reply never reached `~/.claude/handoffs/`, and another plugin's prompt arriving at the same time could be saved as the handoff instead.
- **Corrections.** A correction typed while Claude is still working now counts toward the "corrections in a row" advice.

## 0.8.5 — 2026-10-11

### Fixed

- **Learn pane.** Clicking an earlier lesson in the desktop app now shows its full text; it stayed cut off at one line. Click its time to fold it again.

## 0.8.4 — 2026-10-11

### Changed

- **Learn pane.** Clicking an earlier lesson only shows its full text, without repeating the date and repo the pane already shows. The newest lesson, never cut short, is no longer clickable.

## 0.8.3 — 2026-10-11

### Changed

- **Learn pane.** Each lesson shows the time next to its date. Click a lesson to read it whole, with the full date and its repo; click again to fold it. **show N more** under Earlier lists every older lesson of a topic, not just two. Habits sit in a box of their own, each command on its own line above its reason.

## 0.8.2 — 2026-10-11

### Changed

- The mod no longer names or looks for other plugins: `/route away`'s "Keep warm" option, the field guide and the README describe idle pings without pointing to a tool, and the startup check for a second cold-send guard is gone.

## 0.8.1 — 2026-10-11

### Added

- **Next-step advice switch.** `/route next on|off`, or the new **Next-step advice** row in the Routes pane, shows or hides the band's `next /clear`, `/compact` or `/handoff` and the advice tip at the top of the Context pane. On by default. Off also stops learn mode teaching from that advice. Auto-handoff keeps its own switch.

## 0.8.0 — 2026-10-11

### Added

- **Hand off, start fresh, start over.** The band's advice learns four situations from Claude Code's best practices:
  - **Steps still open**: after a commit, near auto-compact or when the conversation fills the context, it says `next /handoff` instead of clear or compact while two or more todos or tasks are open. A written handoff keeps the plan's detail; a summary does not. It names your `/handoff` skill if you have one, and otherwise says how to ask for one.
  - **Plan written**: once `ExitPlanMode` saves a plan, or a `specs/` or `plans/` Markdown file, `SPEC.md` or `PLAN.md` is written, it says `next /clear` and to implement the plan in a fresh context, until another file is edited.
  - **Two corrections in a row**: it says `next /clear` and to start over with one better prompt, or Esc Esc to rewind.
  - **Exploration**: when reads and searches put 30k tokens or more, and 30% of the context, into the main conversation, the Context pane suggests a subagent next time.
- **Auto-handoff (opt-in).** `/route handoff on`, or the new row in the Routes pane: in the cache's last minutes, with work open and nothing typed or running, model-router asks Claude for a handoff while the cache is still warm and saves it under `~/.claude/handoffs/<repo>/`. Once per prompt; it never clears the session. The band then says `next /clear` with the file to resume from.
- **Habits.** The Learn pane lists three habits no hook can spot: `/clear` between unrelated tasks, `/btw` for side questions, and Esc Esc to rewind.
- New learn topics: `handoff`, `plan-ready`, `corrections`, `exploration`, `auto-handoff`.

### Changed

- The compact advice for a conversation-heavy context also offers Esc Esc → *Summarize up to here*.

## 0.7.0 — 2026-10-11

### Added

- **Carry on, compact or clear.** When carrying on is not the best move, the band shows `next /clear` or `next /compact`; click it for the reason in the Context pane, priced for this session.
  - **Clear**: after a `git commit` or a pull request (`gh pr create` / `merge`) over 50k tokens or more, until your next prompt. Also when the cache has gone cold over a big context, since `/compact` would pay the rewrite too.
  - **Compact**: within 15% of auto-compact, or when the conversation is most of a context that is 60% of the way there.
  - These replace the Context pane's own compaction tips, so the band and the pane always agree.
  - With learn mode on, a toast explains why clearing after a commit pays. Its new topic is `strategy`. A growing context is still taught by `context-high`, which now also says what to keep when compacting.
- **Unused MCP servers and plugins.** The mod notes, per repo, which MCP servers and plugins are loaded and which get used, from tool calls, skills, plugin agents and slash commands. Once one has been loaded for two weeks and ten sessions without use in 30 days, the Context pane tips and the new `/route unused` name it with the setting that turns it off. Recording starts with this version.
  - `/route unused` groups them: the MCP servers in one line with the `/mcp` fix (off for that repo only), `"disableClaudeAiConnectors": true` when none of the connected claude.ai connectors is used, and a ready-to-paste `enabledPlugins` block for `.claude/settings.local.json`. Anything no repo uses points to its config or `/plugin` instead.
  - Servers are named as `/mcp` names them, `claude.ai Gmail` and `plugin:slint:slint-docs` included.
  - Only connected servers count: a connector you never signed in to offers just its sign-in tools and is never listed. A plugin listed covers its own MCP server, which isn't listed again.
  - A plugin's hooks can't be seen, so plugin lines say so, and plugins with only hooks are never listed.
  - Each session counts once, even across `/login` or `/reload-plugins`, and calls not yet saved count straight away.
  - `MODEL_ROUTER_IDLE_DEV=1` lists them after a single session, for trying it out.

### Fixed

- `/reload-plugins` no longer loses the prompt still running: its cost stays in the footer's `▤ today` and is saved to Stats when it finishes. Before, a reload dropped it from both.

## 0.6.4 — 2026-10-10

### Changed

- Tips in the Context, Last prompt cost and Stats panes sit in their own amber-bordered box, so they no longer blend into the figures above them.

## 0.6.3 — 2026-10-10

### Fixed

- Every name the panes show from outside the mod is stripped of terminal control characters: slash command labels in Stats, the repo name in Stats and Learn, agent types in the Routes and Last prompt panes, and unknown model names. History and lessons saved by earlier versions are cleaned when they load.
- `claude plugin validate` passes again: the Learn pane's scope setting from 0.6.2 is declared in the plugin's types.

## 0.6.2 — 2026-10-10

### Changed

- The Learn pane shows this repo's lessons first, with **This repo** / **All** buttons like the Stats pane; the choice is kept across sessions. When this repo has none yet, it says how many other repos have under All.
- The band's **Learn ●N** count follows that scope, so it no longer counts lessons from other repos while the pane shows only this one.

## 0.6.1 — 2026-10-10

### Changed

- The Learn pane is titled **Learn · all repos**, since lessons, mutes and learn mode are shared by every repo and session. Once its lessons come from more than one repo, each fact starts with the repo it came from.

## 0.6.0 — 2026-10-10

### Added

- Tips at the bottom of the Context, Last and Stats panes: up to three each, biggest saving first, worked out locally with no model call.
  - **Context**: a memory file of 3k tokens or more (CLAUDE.md, auto-memory), an MCP server whose loaded tool schemas reach 5k, a skills listing of 3k or more, custom agent descriptions of 2k or more, a conversation filling most of the window, or auto-compaction close ahead.
  - **Last**: how to avoid the cache rewrite the prompt paid for, a cheaper route when Opus or Fable did most of the work, or which subagent route to move when subagents did most of the spending. Always on, unlike the learn mode toasts.
  - **Stats**: cache rewrites adding up, a command averaging 3× a plain prompt or more, or Opus and Fable doing 80% of the spending.

## 0.5.1 — 2026-10-09

### Fixed

- Stats in the desktop app: a long prompt no longer pushes its cost off the row; it ends in "…" instead. The same holds for long names in the other panes.
- Stats shows slash commands as typed (`/simplify and commit`) and a message from an agent as `agent message`, not the tags Claude Code wraps them in. Prompts recorded earlier are cleaned up too.
- Stats keeps its gap between the average-cost and most-expensive sections in the desktop app.

## 0.5.0 — 2026-10-09

### Added

- Learn mode topics can be muted: **mute** beside each topic in the Learn pane, or `/route learn mute <topic>`. A muted topic is not kept, toasted or counted, and a muted `cold-rewrite` drops the "Why" from the cold-send guard. Muted topics are listed at the bottom of the pane to unmute.

### Changed

- The Learn pane is easier to scan: each topic sits in its own card, the latest fact leads with its date in a column of its own, earlier facts take one line each, and the "why" comes after the facts.
- The band's **Learn ●N** counts lessons that toasted and the first of each topic, not every quiet repeat: with Opus routed on the main loop, the expensive-model lesson no longer grows the count on each prompt.

## 0.4.0 — 2026-10-09

### Added

- Learn mode, off by default: `/route learn on`. Cache rewrites, an expensive model doing most of a prompt, context growing toward auto-compact, compaction and subagent-heavy prompts each become a lesson with the measured numbers: a toast when it happens (at most one per turn, once an hour per topic, three times per topic) and a **Learn** pane that explains each concept the first times and lists the facts. The band shows **Learn ●N** while lessons are unread.
- Learn mode warns before a cost too: 5 minutes before the cache goes cold while idle, when plan mode is routed differently from normal work (what each switch rewrites, including the way back), and why the cold-send guard held a message.
- Learn mode can be switched on and off from the `/route` pane, where it is described, and from the Learn pane.
- `/route away`: before a break, the ways to step away from a session (note plus `/clear`, `/compact` while warm, `/rename` and `/resume`, keep-warm pings, nothing), each priced for the session's context, routed model and cache.

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
