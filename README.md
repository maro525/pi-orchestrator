# pi-graph

A dynamic project orchestrator for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — Path C hybrid: a thin code layer (routing / gates / budget / fallback) over editable markdown agent definitions.

## What it does

`/orchestrate <task or Linear ID>` runs the full project workflow with **per-phase model routing**:

```
classify tier (XS/S/M/L)
  → startproject  (plan)
  → team-implement (implement)
  → team-review    (review — PASS/FAIL)
  → deploy         (PR + Linear update)
```

### Dynamic control (the code layer)

| Capability | How |
|---|---|
| **Per-phase model routing** | `orchestrator.json` → `tiers[tier][phase]` resolved per phase, spawned as isolated `pi` subprocesses |
| **Per-phase thinking level** | `thinkingLevel[phase]` (off/minimal/low/medium/high/xhigh/max) |
| **Tier classification** | Keyword heuristics + hard triggers (auth, DB migration, payment, public API, core deps → force L). Override with `--tier=` |
| **Gate 1 (plan approval)** | `ctx.ui.confirm` dialog after `startproject`. `--dont-ask` auto-approves |
| **Gate 3 (review FAIL)** | `ctx.ui.select` → retry / continue / abort. **Retries re-implement with review feedback injected**, then re-review (up to `maxRetries`) |
| **429 / error fallback** | Subprocess detects 429/hard-error → auto-switches to `fallbackModel` |
| **Budget tracking** | Per-phase + total cost; warns and confirms on overflow |
| **State persistence** | Unified task file at `.claude/docs/decisions/task-*.md` |

### Editable behavior (the markdown layer)

- `agents/*.md` — phase procedures (frontmatter: `name`, `description`, `tools`, `model`)
- `prompts/orchestrate.md` — entry-point prompt template
- `orchestrator.json` — tier→model mapping, budget, gates, hard triggers

No code changes needed to adjust models, procedures, or review criteria — edit the markdown/json and `/reload`.

## Install

The repo is designed to live at `~/project/pi-graph` and symlink into `~/.pi/agent/`:

```bash
ln -sf ~/project/pi-graph/extensions/orchestrator ~/.pi/agent/extensions/orchestrator
ln -sf ~/project/pi-graph/agents                  ~/.pi/agent/agents
ln -sf ~/project/pi-graph/prompts                 ~/.pi/agent/prompts
ln -sf ~/project/pi-graph/orchestrator.json       ~/.pi/agent/orchestrator.json
ln -sf ~/project/pi-graph/orchestrator.schema.json ~/.pi/agent/orchestrator.schema.json
```

Requires the `subagent` extension (shipped with pi) for `discoverAgents`.

## Usage

```
/orchestrate NSKETCH-573 カート機能にクーポン適用を追加する
/orchestrate refactor auth to support OAuth --tier=L
/orchestrate typo fix --dont-ask
```

## Structure

```
pi-graph/
├── extensions/orchestrator/
│   ├── index.ts     # command + tool registration, gates, budget, main flow
│   ├── config.ts    # tier classification, model routing, arg parsing
│   ├── runner.ts    # pi subprocess spawn, JSON parsing, 429 fallback
│   └── agents.ts    # agent discovery (from subagent extension)
├── agents/
│   ├── startproject.md
│   ├── team-implement.md
│   ├── team-review.md
│   └── deploy.md
├── prompts/
│   └── orchestrate.md
├── orchestrator.json           # tier→model mapping, budget, gates
└── orchestrator.schema.json
```
