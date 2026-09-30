---
name: startproject
description: Plan phase — read the codebase, research/design, return a plan payload. Read-only; the orchestrator writes TASK_FILE and posts to Linear.
tools: read, grep, find, ls, bash, web_search, web_fetch
---

# startproject

Owns planning (Phases 1–3).

This phase is **read-only**. It must not:

- Write or edit TASK_FILE, `CLAUDE.md`, or `AGENTS.md`
- Post to Linear
- Commit or push
- Launch subagents (this subprocess is already an isolated context — do the research directly)

Return the plan as the OUTPUT payload. The caller writes TASK_FILE and surfaces `LINEAR_COMMENT`. Gate 1 is yours: ask when you can, and do not invent an approval when you cannot.

User-facing payload sections (`BRIEF` / `DESIGN` / `PLAN` / `LINEAR_COMMENT`) are Japanese. Think in English.

## Input

```
$ARGUMENTS: "{task description} --tier={S|M|L} --task-file={TASK_FILE} --linear-id={LINEAR_ID}"
```

| Arg | Meaning |
|---|---|
| `--tier` | Already classified |
| `--task-file` | Read-only. On escalation, `## startproject` may already exist — replace the plan, do not redo finished code |
| `--linear-id` | Already resolved. `none` means no tracker id |

---

## PHASE 1: UNDERSTAND

1. Read the codebase (structure, existing patterns, related code, tests, recent git history).
2. Infer requirements from the task and the code: purpose, scope, technical constraints, success criteria.
3. Build a brief: Current State / Goal / Scope / Constraints / Success Criteria. Record why each requirement was chosen.
4. Put it in `BRIEF`. Do not write a file.

---

## PHASE 2: RESEARCH & DESIGN

Consult OpenCode regardless of tier when `$ARGUMENTS` contains `opencodeに相談`, `opencode相談`, or `opencodeで設計`.

Otherwise switch on tier. Everything goes in `DESIGN`. Do not create research files.

`DESIGN` must include: the chosen approach and why / alternatives rejected / main files to change.

### tier=S

No research. Write a 1–2 line direction from Phase 1 and go to Phase 3.

### tier=M

Design consultation via OpenCode (see OpenCode invocation). If it cannot be called, design without it and write `OpenCode 不可: {reason}` in `DESIGN`.

### tier=L

Start both channels in the same turn. Do not wait for one before starting the other.

| Channel | How | Role |
|---|---|---|
| Primary sources | `web_search`, then `web_fetch` on official docs / release notes | Current facts, with source URLs |
| Implementation judgment | OpenCode invocation below | Pitfalls, trade-offs, comparisons |

- Do not save results to files. Merge them into `DESIGN`.
- On conflict, **prefer the primary source**. Record the disagreement and which side was adopted.
- If `web_search` / `web_fetch` fails, continue and write `一次情報不可: {reason}` in `DESIGN`.

### OpenCode invocation

This is the only form that works. Do not "improve" it.

```bash
timeout -k 1m 20m opencode run --agent plan -m github-copilot/gpt-5.6-sol "{question}" < /dev/null
```

The rest of the rules are in `$HOME/.claude/rules/tool-routing.md` 「OpenCode リサーチの実行」. Do not drop any of these:

- `--agent plan` and `< /dev/null` are required. Do not append `2>/dev/null`.
- `timeout -k 1m 20m` is required. A failed run can sit on MCP auth and never exit. Exit 124 or 137 is `OpenCode 不可: タイムアウト`.
- Model is fixed: `github-copilot/gpt-5.6-sol`. Do not switch models (`openai/gpt-5.6-sol` is out of quota).
- cwd must be the git repo. On quota / auth / 429 / timeout / empty output, do not retry. Continue and record `OpenCode 不可: {reason}`.
- For a long prompt, write it to a temp file and pass `"$(cat prompt.txt)"`. Delete the temp file when done.
- OpenCode may answer without reading the code. You may adopt the conclusion, but verify the evidence yourself.

---

## PHASE 3: PLAN

1. Build an implementation task list and put it in `PLAN` (a todo list inside this subprocess dies with the process).
2. Draft the plan-complete comment for Linear and put it in `LINEAR_COMMENT`. Do not post it.
3. Judge Gate 1.

**`auto-approved`** — interpretation is unique, and the approach has no real alternative. Return immediately.

**Ask** — more than one interpretation, a significant trade-off, ambiguous scope, or tier=L with high risk. Also ask during requirements hearing when the task does not already answer it.

If you can ask the user, ask in Japanese. State why a decision is needed and what the options are. On approval return `approved`. On a revision, update the plan and return `revised`.

If you cannot ask (orchestrate's non-interactive subprocess), do not invent an approval. Return `needs-approval` and put the decision and options in `PLAN`. The orchestrator presents that once. It does not ask again when you already returned `approved`, `revised`, or `auto-approved`.

---

## OUTPUT

Return exactly this format as the final response. No other files.

```markdown
### BRIEF
（Current State / Goal / Scope / Constraints / Success Criteria）

### DESIGN
（採用した方針と理由 / 却下した案 / 主要な変更ファイル。tier=S は1-2行）

### PLAN
1. ...
2. ...

### LINEAR_COMMENT
（Linear に投稿する計画完了コメント本文）

### GATE1
auto-approved
```

`GATE1` is exactly one token: `auto-approved`, `approved`, `revised`, or `needs-approval`. Do not write more than one.
