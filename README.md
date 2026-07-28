# pi-orchestrator

A dynamic project orchestrator for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — a thin code layer (routing / gates / budget / fallback) over editable markdown agent definitions.

Instead of every phase running on one fixed model, pi-orchestrator **routes a different model to each phase** (plan / implement / review / deploy) based on task complexity, with interactive approval gates, automatic review-feedback retries, cost budgeting, and 429 fallback — all configurable via a single JSON file and markdown agent definitions.

## What it does

`/orchestrate <task description>` runs the full project workflow with **per-phase model routing**:

```
classify tier (XS/S/M/L)
  → startproject   (plan — understand codebase, design, create plan)
  → team-implement (implement — code, test, write to task file)
  → team-review    (review — parallel reviewers, PASS / FAIL)
  → deploy         (deploy — push branch, create PR, update tracker)
```

Each phase runs as an **isolated pi subprocess** with its own context window, model, and thinking level.

### Dynamic control (the code layer)

| Capability | How |
|---|---|
| **Per-phase model routing** | `orchestrator.json` → `tiers[tier][phase]` resolves a model per phase, spawned as isolated `pi` subprocesses |
| **Per-phase thinking level** | `thinkingLevel[phase]` — e.g. plan at `high`, implement at `medium`, review at `high`, deploy at `low` |
| **Tier classification** | Keyword heuristics + hard triggers (auth, DB migration, payment, public API, core deps → force L). Override with `--tier=` |
| **Gate 1 (plan approval)** | Confirm dialog after `startproject` — approve, or send back for re-planning. `--dont-ask` auto-approves |
| **Gate 3 (review FAIL)** | Select dialog → retry / continue / abort. **Retries re-implement with review feedback injected into the task**, then re-review (up to `maxRetries`) |
| **429 / error fallback** | Subprocess detects 429 rate-limit or hard error → auto-switches to `fallbackModel` and retries |
| **Budget tracking** | Per-phase + total cost; warns on approach, confirms on overflow |
| **State persistence** | Unified task file written to `.claude/docs/decisions/task-*.md` — shared SSoT across all phases |

### Editable behavior (the markdown layer)

- `agents/*.md` — phase procedures (frontmatter: `name`, `description`, `tools`, `model`)
- `prompts/orchestrate.md` — entry-point prompt template
- `orchestrator.json` — tier→model mapping, budget, gates, hard triggers

No code changes needed to adjust models, procedures, or review criteria — edit the markdown/json and run `/reload`.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) installed and on your `PATH`
- At least one model provider configured (`pi --list-models` should show models)
- The `subagent` extension (shipped with pi) must be installed for agent discovery

## Install

Clone the repo wherever you like, then symlink the four components into your pi agent directory:

```bash
# 1. Clone
git clone https://github.com/maro525/pi-orchestrator.git
cd pi-orchestrator

# 2. Symlink into pi's agent directory
ln -sf "$PWD/extensions/orchestrator"       ~/.pi/agent/extensions/orchestrator
ln -sf "$PWD/agents"                         ~/.pi/agent/agents
ln -sf "$PWD/prompts"                        ~/.pi/agent/prompts
ln -sf "$PWD/orchestrator.json"             ~/.pi/agent/orchestrator.json
ln -sf "$PWD/orchestrator.schema.json"      ~/.pi/agent/orchestrator.schema.json
```

> The symlinks let you edit files in the cloned repo (with git version control) while pi loads them live from `~/.pi/agent/`.

Start (or restart) pi and run `/reload` to pick up the extension. You should see `orchestrator ready (tiers: XS/S/M/L)` in the status bar.

## Configure

Edit `orchestrator.json` to match your available models and preferences:

```jsonc
{
  "tiers": {
    "XS": { "startproject": null, "team-implement": "provider/cheap-fast", "team-review": null, "deploy": "provider/cheap-fast" },
    "S":  { "startproject": "provider/cheap-fast", "team-implement": "provider/capable", "team-review": "provider/cheap-fast", "deploy": "provider/cheap-fast" },
    "M":  { "startproject": "provider/capable", "team-implement": "provider/capable", "team-review": "provider/capable", "deploy": "provider/cheap-fast" },
    "L":  { "startproject": "provider/capable", "team-implement": "provider/capable", "team-review": "provider/capable", "deploy": "provider/capable" }
  },
  "thinkingLevel": { "startproject": "high", "team-implement": "medium", "team-review": "high", "deploy": "low" },
  "fallbackModel": "provider/cheap-fast",
  "fallbackThinkingLevel": "medium",
  "budget": { "maxCostPerPhase": 0.8, "maxTotalCost": 3.0, "warnCostPerPhase": 0.4 },
  "gates": { "gate1": true, "gate3": true, "dontAsk": false, "maxRetries": 1 },
  "hardTriggers": ["auth", "db migration", "payment", "public api", "core dependency"]
}
```

- `null` for a phase = skip that phase for the tier (e.g. XS skips planning and review)
- Use `provider/model-id` format from `pi --list-models`
- Append `:thinking-level` to a model in `tiers` to override per-tier (e.g. `provider/model:high`)

## Usage

```
/orchestrate add coupon application to the cart feature
/orchestrate refactor auth to support OAuth --tier=L
/orchestrate fix the typo in the header --dont-ask
```

### Flags

| Flag | Effect |
|------|--------|
| `--tier=XS\|S\|M\|L` | Override auto tier classification |
| `--dont-ask` | Auto-approve all gates, auto-retry on review FAIL |

### What happens

1. **Classify** — tier is estimated from the task description (or your `--tier` override). Hard triggers force L.
2. **Route** — a model is resolved per phase from `orchestrator.json`.
3. **Plan** (`startproject`) — reads codebase, designs, writes plan to task file. **Gate 1** asks you to approve.
4. **Implement** (`team-implement`) — codes the change, runs tests, writes to task file.
5. **Review** (`team-review`) — parallel reviewers (Quality / Logic / Security / Simplify) judge PASS / FAIL.
   - **FAIL** → **Gate 3** asks: retry (re-implement with feedback) / continue / abort.
6. **Deploy** (`deploy`) — pushes feature branch, opens PR, updates tracker status.
7. **Report** — final summary with per-phase cost, model, and outcome.

## Structure

```
pi-orchestrator/
├── extensions/orchestrator/
│   ├── index.ts     # command + tool registration, gates, budget, main flow
│   ├── config.ts    # tier classification, model routing, arg parsing
│   ├── runner.ts    # pi subprocess spawn, JSON parsing, 429 fallback
│   └── agents.ts    # agent discovery (self-contained)
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

## License

MIT
