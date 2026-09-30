---
description: Project orchestrator — classify tier, then run startproject → team-implement → team-review → deploy. Phases return payloads; the orchestrator writes the task file.
argument-hint: "<task description or Linear ID>"
---
Use the orchestrator to run the full project workflow for:

$ARGUMENTS

The orchestrator will:
1. Classify the tier (XS/S/M/L). XS stops here — implement that directly, do not start the pipeline
2. Resolve a model per phase from orchestrator.json
3. Run startproject → team-implement → team-review → deploy as isolated pi subprocesses
4. Write TASK_FILE from each phase's OUTPUT payload (phases do not write the file or post to Linear)
5. Gate 1: do not ask again if startproject already returned auto-approved, approved, or revised. Ask only for needs-approval. Gate 2: on review FAIL, ask whether to return to implement. FAIL does not deploy
6. On ESCALATION, raise the tier and re-plan. Finished code stays on the work branch
7. Track budget, fall back on 429, and report Linear comments that could not be posted

Pass the full task description (including any Linear ID like NSKETCH-573).
