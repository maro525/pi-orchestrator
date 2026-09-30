---
name: team-review
description: Review phase — reviewers by tier (S: self / M: +OpenCode, Security / L: +Simplify). Returns PASS/FAIL. Does not edit code, write TASK_FILE, or post to Linear.
tools: read, bash, grep, find, ls
---

# team-review

Owns review. **Does not modify code** — fixes go back to team-implement. Does not write TASK_FILE or post to Linear. TASK_FILE is read-only. Return the OUTPUT payload. The orchestrator appends it as `### {n}回目` (FAIL included, never overwritten).

This phase is a non-interactive subprocess. Do not ask whether to verify. If the change is UI-related, check the browser. If it is logic, run tests. If both, do both.

## Input

```
$ARGUMENTS: "{task description} --tier={S|M|L} --task-file={TASK_FILE} --linear-id={LINEAR_ID}"
```

---

## Pre-flight

1. `## startproject` > `### Brief` — scope, success criteria
2. `## startproject` > `### Design` — intent
3. `## team-implement` latest round — summary and handoff. On a retry, also check that the previous `## team-review` findings were addressed
4. The diff: uncommitted changes on the work branch (`git diff` / `git status`). team-implement does not commit

Classify the change (both may apply):

| Nature | Signal | Verification |
|---|---|---|
| UI | components, CSS, layout | Browser check |
| Logic | business logic, API, data | Tests |

---

## STEP 1: Code review (parallel)

Launch the tier's reviewers together. Do not edit files.

| tier | Reviewers |
|---|---|
| S | Self |
| M | Self / OpenCode / Security |
| L | Self / OpenCode / Security / Simplify |

| Reviewer | Method |
|---|---|
| Self | Read the diff. Quality (readability, naming, duplication, SOLID) and Logic (bugs, edge cases, error handling) |
| OpenCode | Second opinion, same Quality / Logic lens, different model. See below |
| Security | Read `$HOME/.claude/rules/security.md` (if missing, `$HOME/_dotfiles/claude/rules/security.md`) and check the diff against it. If neither file exists, check authz, input validation, hardcoded secrets, and injection, and note that security.md was absent |
| Simplify | Excessive complexity, duplication, existing code that should have been reused. Do not run a rewrite/simplify skill — it edits code |

### OpenCode reviewer

The diff is long, so write the prompt to a temp file and pass it. Same invocation rules as startproject, including `timeout -k 1m 20m`. Exit 124 or 137 is `OpenCode 不可: タイムアウト`. Do not retry or switch models. If it cannot be called, skip this reviewer and write `OpenCode 不可: {reason}`.

```bash
timeout -k 1m 20m opencode run --agent plan -m github-copilot/gpt-5.6-sol "$(cat {prompt_file})" < /dev/null
```

Prompt body:

```
DO NOT USE ANY TOOLS.
以下のコード変更をレビューしてください。Quality / Logic の観点で問題点と改善提案を列挙してください。

{diff}
```

Delete the temp file when done.

---

## STEP 2: Integrate

- Merge duplicate findings and raise severity
- On conflict, keep the stricter finding
- Move minor findings to handoff notes

---

## STEP 3: Verify

### UI → browser

Open the target page and exercise the states. Record what you checked. Tool choice is yours; do not skip the check because you cannot ask.

### Logic → tests

Run the project's test command (`package.json` / `pyproject.toml` / `AGENTS.md` / `CLAUDE.md`). Note whether new behavior has tests.

---

## STEP 4: Verdict

| severity | Definition | Effect |
|---|---|---|
| critical | Vulnerability, data loss, test failure | FAIL |
| major | Bug, serious design issue, broken UI | FAIL |
| minor | Naming, style, refactor suggestion | PASS (handoff) |

- **PASS** — zero critical / major
- **FAIL** — one or more critical / major

Do not deploy. Do not fix the code.

---

## OUTPUT

Return exactly this format as the final response.

```markdown
### VERDICT
PASS

### REVIEW

#### コードレビュー統合結果

##### Self Reviewer
- [severity] 指摘内容

##### OpenCode Reviewer
- [severity] 指摘内容

##### Security Reviewer
- [severity] 指摘内容（security.md ルール参照）

##### Simplify Reviewer
- [severity] 指摘内容

##### 統合サマリー
- 複数レビュアー共通の指摘（severity 引き上げ）
- 個別の指摘

#### 動作検証結果

##### ブラウザ表示確認（該当する場合）
- 確認したページ・状態
- 問題点（あれば）

##### テスト実行結果（該当する場合）
- 実行コマンド
- 結果サマリー
- 失敗したテスト（あれば）

#### 申し送り事項（minor）
- deploy フェーズへの注意点
- リファクタリング推奨（次タスクで対応）

### LINEAR_COMMENT
（Linear に投稿するレビュー結果コメント。PASS/FAIL + サマリー）
```

`VERDICT` is exactly one token: `PASS` or `FAIL`. Do not write both. Omit reviewer subsections that did not run. `REVIEW` and `LINEAR_COMMENT` are Japanese.
