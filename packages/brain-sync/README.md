# brain-sync

Mirrors every project, file and AI coding session on this Mac into one linked Obsidian vault, a "second brain" graph:

```
🧠 Home → 🛠 Tools (Claude, Codex, Gemini, omp) → 📦 Projects → 📁 Folders → files
                                                   ↖ Sessions (prompts, AI summary, files touched)
```

It stays current on its own. You don't need to run anything by hand.

| Trigger | What fires it |
|---|---|
| Claude Code hooks (`SessionStart`, `Stop`, `SessionEnd`, `PostToolUse` on edits) | every Claude session, every turn, every file edit |
| Background watcher (launchd `com.brain-sync.watch`) | any change under `~/Documents/Projects`, Codex/omp session logs, plus a 5-minute tick |
| Agentic OS (upcoming) | missions and their agents |

## Vault layout (`~/Documents/Obsidian/Brain`)

- `🧠 Home.md`: the hub. It lists tools, a table of projects, recent sessions and stats.
- `Tools/<Tool>.md`: each tool's projects, sessions and the models it used.
- `Projects/<Tool>/<Project>/📦 <Project>.md`: path, stack, README summary, structure, sessions and recently changed files.
- `…/📁 <folder>.md` and `…/<file>.md`: one note per folder and per source file. File notes hold the outline (functions and classes), links to the files they import, and the sessions that touched them.
- `Sessions/<Tool>/<date time> <title>.md`: a Haiku-written summary, your prompts, the files touched, the final reply and a resume command.
- `Archive/`: notes for deleted files that you had written in. Only your own text is kept.

Build output, dependencies and binaries are never indexed (`node_modules`, `.build`, `DerivedData`, `*.o`, …). `.gitignore` files are respected.

If a project folder is deleted, its note stays, marked **deleted**, so its sessions remain linked.

**Your own notes:** write anything below the `%% brain:user … %%` line in any generated note. Syncs keep it, and if the source disappears it moves to `Archive/`. brain-sync never touches notes it didn't create.

## Commands

```sh
~/.brain-sync/bin/brain-sync               # incremental sync (~50 ms when nothing changed)
~/.brain-sync/bin/brain-sync --full        # re-analyze everything
~/.brain-sync/bin/brain-sync --summaries all|none
~/.brain-sync/bin/brain-sync status        # hooks / watcher / last run
~/.brain-sync/bin/brain-sync install       # (re)install hooks + watcher, full sync, open Obsidian
~/.brain-sync/bin/brain-sync uninstall     # remove hooks + watcher (vault is kept)
```

From the repo: `npm run brain -- status`, `npm test -w brain-sync`.

## Config: `~/.brain-sync/config.json`

`vault`, `projectsRoot`, `sessionSources`, `summarize` (`enabled`, `command`, `model`, `idleMs`, `maxPerRun`), `maxFileBytes`, `maxFilesPerProject`, `extraIgnore` (gitignore-style patterns).

Summaries run through `claude -p --model haiku` using your existing Claude login, isolated from your settings and hooks, and with no session saved. A session is summarized once it has been idle for 2 minutes or has ended, and again only if it changes.

Logs: `~/.brain-sync/logs/{watch,sync}.log`.
