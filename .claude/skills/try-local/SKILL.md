---
name: try-local
description: Opens a Claude session in a new terminal tab with this checkout of model-router in place of the installed one, so the user can try uncommitted changes. Use when the user wants to try, see, test by hand or run the mod locally, or asks for a session with the local copy.
---

# Try the mod locally

1. Pick the folder: the one the user names (a bare repo name means a sibling of this repo's folder; check it exists), else this repo. For handoff work, a repo with files in `~/.claude/handoffs/<repo>/` shows the most.
2. Open a new terminal tab (`mcp__terminal__open_terminal_tab` or `run_in_terminal`) running:
   `<this repo's root>/scripts/try.sh <folder>`, as an absolute path, since the tab may start elsewhere.
   Add `MODEL_ROUTER_IDLE_DEV=1 ` in front when the change is about unused MCP servers or plugins.
   If the script prints validation errors instead of starting, show them and stop.
3. Bring the tab into view (`mcp__ccd_view__show_pane` with `pane: "terminal"` and its `tab_id`): opening a tab does not show the Terminal pane. Then link the tab and give a short checklist of what to look at, taken from the uncommitted diff (`git diff --stat`, then the user-visible parts): which band item, pane, command or button changed, and what it should do now.
4. Tell the user once:
   - After an edit, `/reload-plugins` in that tab picks it up; no restart.
   - The installed copy is off only in that tab. Other sessions keep it.
   - The local copy keeps its own saved state (stats, handoff statuses), separate from the installed one. Files on disk, such as handoffs, are shared.
