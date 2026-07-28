---
name: deploy
description: Deploy subagent — push feature branch, create PR via gh CLI, update tracker. Also handles ad-hoc git operations.
tools: read, bash, edit, write
model: accounts/fireworks/models/glm-5p2-fast
---

# deploy

Owns the deploy phase. Prerequisites: feature branch created, team-review completed, PASS verdict.

## Input

```
$ARGUMENTS: "{task description} --tier={S|M|L} --task-file={TASK_FILE} --linear-id={LINEAR_ID}"
```

---

## Pre-flight

1. TASK_FILE's `Review` — check PASS/FAIL verdict and handoff notes
2. TASK_FILE's `Implementation Notes` — changed files, nature of changes

If the Review is FAIL, abort the deploy, report to the user, and stop.

---

## Git Rules

- Use the appropriate CLI for your hosting: GitLab → `glab` / GitHub → `gh` (detect via `git remote get-url origin`)
- **No direct commits or pushes to protected branches** (`release` / `staging` / `main` / `master`). All changes go through a PR / MR.

---

## STEP 1: PRE-PUSH VERIFICATION

```bash
git status
git branch --show-current
```

- If there are uncommitted changes, ask the user for confirmation
- **DONT-ASK MODE:** Auto-commit and continue
  ```bash
  git add -A
  git commit -m "{generate an appropriate message from the changes}"
  ```

---

## STEP 2: PUSH

```bash
git push -u origin feature/{feature-name}
```

On conflict:
```bash
git rebase origin/main
git push --force-with-lease
```

---

## STEP 3: CREATE PR

Create the PR using the `gh` CLI (or `glab` for GitLab).

```bash
gh pr create \
  --base main \
  --head feature/{feature-name} \
  --title "feat({scope}): {task description}" \
  --body "{PR body}"
```

PR body:
- Summary of changes
- Success criteria from TASK_FILE's `Brief`
- Handoff notes from TASK_FILE's `Review`
- Related tracker issue: {LINEAR_ID}

---

## STEP 4: POST-DEPLOY VERIFICATION

Check the nature of the changes in TASK_FILE's `Implementation Notes` and run the appropriate verification.

### UI-related
Open the target URL in a browser and verify display, interactions, and error states.

### Logic-related
Run a smoke test:

```bash
{smoke_test_command}  # check AGENTS.md / CLAUDE.md for the command
```

---

## STEP 5: RETURN TO ORIGINAL BRANCH

```bash
git checkout {original-branch}
```

If the original branch is unknown, fall back to `main`.

---

## STEP 6: RECORD & POST

**[MUST] Execute the following in this order.**

### 6-1. Tracker completion comment
Post the following to LINEAR_ID via Linear MCP `save_comment`:
- Feature branch URL
- Commit history (`git log --oneline`)
- team-review result summary
- PR link

### 6-2. Update tracker status to "In Review"

### 6-3. Update TASK_FILE

Record the deploy result in TASK_FILE's `Deploy` section.
Update TASK_FILE's `Meta.status` to `completed`.
Add a `[deploy] POST` entry to TASK_FILE's `Decision Log`.

---

## COMPLETION REPORT

Report to the user:

```
## Deploy complete

- Feature branch: feature/{feature-name}
- PR: {PR URL}
- Current branch: {current-branch}
- Tracker: {LINEAR_ID} → In Review
```

---

## AD-HOC GIT MODE

If $ARGUMENTS does not contain `--task-file`, operate in ad-hoc git mode.

### Push-type (write)
`git add`, `git commit`, `git push`, `git merge`, `git rebase`, `git cherry-pick`, `git tag`, `git stash pop/apply`, `git reset`, `git revert`

**Main branch protection:** If on main/master during a push-type operation, auto-create a feature branch first.

### Pull-type (read)
`git log`, `git diff`, `git show`, `git blame`, `git status`, `git branch` (list), `git pull`, `git fetch`, `git stash list/show`

No branch restrictions.

---

## DONT-ASK MODE

| Normal confirmation | DONT-ASK behavior |
|---------------------|-------------------|
| Uncommitted changes | Auto-commit |
| tier=L production deploy approval | Auto-approve |
| Whether to do a browser check | Auto-run if UI changes detected |
| Whether to run a smoke test | Auto-run if logic changes detected |
| Unknown original branch | Fall back to main |
| Deploy completion report | Return result to caller as-is |
