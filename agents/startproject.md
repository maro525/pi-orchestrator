---
name: startproject
description: Plan phase — understand codebase, research/design, create plan. Writes Brief / Design / Decision Log to TASK_FILE.
tools: read, grep, find, ls, bash
---

# startproject

Owns the planning phase (Phases 1–3). Updates TASK_FILE as the single source of truth (SSoT).

## Input

```
$ARGUMENTS: "{task description} --tier={S|M|L} --task-file={TASK_FILE} --linear-id={LINEAR_ID}"
```

---

## PHASE 1: UNDERSTAND

1. Read the codebase directly via Read / Glob / Grep
   - Structure, key modules, existing patterns, related code, test setup
   - If git history is needed:
     ```bash
     git log --oneline -20
     git show <commit>
     ```

2. Requirements gathering
   - Purpose, scope, technical requirements, success criteria, final design
   - **DONT-ASK MODE:** Infer from already-provided information and continue

3. Create a project brief
   - Current State / Goal / Scope / Constraints / Success Criteria

4. **[MUST]** Write the brief into TASK_FILE's `Brief` section

5. **[MUST]** Record requirement decisions in the Decision Log
   - Add a `[startproject] DECISION` entry for each requirement

6. **[MUST]** Add a `[startproject] PRE` entry to TASK_FILE's `Decision Log`

---

## PHASE 2: RESEARCH & DESIGN

**If $ARGUMENTS contains keywords like "design consultation" or "second opinion" → launch a parallel design consultation via subagent, regardless of tier.**

All outputs go into TASK_FILE's `Design` section (no external files).

### tier=S
Skip → proceed to Phase 3.

### tier=M
Conduct design consultation:
- Formulate a design proposal for the target area
- Write it into TASK_FILE's `Design` section

### tier=L
Launch Researcher and Architect **in parallel**.

| Role | Responsibility |
|------|---------------|
| Researcher | Survey external libraries and prior art |
| Architect  | Define the design direction |

Integrate both outputs and write the result into TASK_FILE's `Design` section.

---

## PHASE 3: PLAN

1. Read TASK_FILE's `Brief` and `Design`, integrate the content

2. Create an implementation task list (record the plan ahead of time in TASK_FILE's `Implementation Notes`)

3. Add a Current Project section to `AGENTS.md` / `CLAUDE.md`
   - Goal / Key files / Architecture / Decisions

4. **[MUST]** Post a plan-completion comment to LINEAR_ID via the Linear MCP `save_comment`
   - Add a `[startproject] POST` entry to the Decision Log

5. Self-evaluate the approval flow using the criteria below

### Approval Flow Criteria

**Auto-approve → return immediately to caller:**
- The task interpretation is unambiguous
- The implementation approach is self-evident with no alternatives
- DONT-ASK MODE is active

**Trigger Gate 1 → wait for user approval:**
- Multiple interpretations of the task are possible
- The implementation approach has significant trade-offs
- The scope is ambiguous
- tier=L and the risk is high

When Gate 1 triggers, present the plan clearly, **explicitly state why a decision is needed and what the options are**, and ask the user for approval.

---

## OUTPUT FILES

All deliverables are consolidated into TASK_FILE.

| Section | Content | tier |
|---------|---------|------|
| `Brief` | Project brief | All tiers |
| `Decision Log` | DECISION / PRE / POST entries | All tiers |
| `Design` | Design direction, research findings | M, L |
| `CLAUDE.md` / `AGENTS.md` | Current Project section added | All tiers |
