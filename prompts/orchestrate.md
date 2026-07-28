---
description: Project orchestrator — classify tier, then run startproject → team-implement → team-review → deploy with per-phase model routing, gates, and budget control.
argument-hint: "<task description or Linear ID>"
---
Use the orchestrator to run the full project workflow for:

$ARGUMENTS

The orchestrator will:
1. Classify the tier (XS/S/M/L) from the task description
2. Resolve a model per phase from the tier→model mapping in orchestrator.json
3. Run startproject → team-implement → team-review → deploy as isolated pi subprocesses
4. Handle Gate 1 (plan approval) and Gate 3 (review FAIL) via confirm dialogs
5. Track cost/token budget and fall back to a cheaper model on 429/errors
6. Write a unified task file and report a final summary

Pass the full task description (including any Linear ID like NSKETCH-573) so tier classification and routing work correctly.
