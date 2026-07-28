/**
 * Orchestrator Extension — Path C hybrid
 *
 * Code (this file + config.ts + runner.ts):
 *   - tier classification & model routing (dynamic, config-driven)
 *   - Gate 1 / Gate 3 confirm dialogs via ctx.ui
 *   - isolated pi subprocess per phase (runner.ts)
 *   - 429 fallback, budget tracking, state persistence
 *
 * Markdown (editable, no code changes needed):
 *   - ~/.pi/agent/agents/{startproject,team-implement,team-review,deploy}.md
 *   - ~/.pi/agent/prompts/orchestrate.md  (entry point)
 *   - ~/.pi/agent/orchestrator.json        (tier→model mapping, budget, gates)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type OrchestratorConfig,
	type Phase,
	type Tier,
	classifyTier,
	detectLinearId,
	loadConfig,
	parseOrchestrateArgs,
	phasesForTier,
	resolvePhaseModel,
} from "./config.ts";
import { runPhase, type PhaseResult } from "./runner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function summarizeResult(r: PhaseResult): string {
	const status = r.exitCode === 0 ? "✓" : "✗";
	const parts = [
		`${status} ${r.phase}`,
		r.fallbackUsed ? "(fallback)" : "",
		`${r.usage.turns} turns`,
		`↑${fmtTokens(r.usage.input)}`,
		`↓${fmtTokens(r.usage.output)}`,
		fmtCost(r.usage.cost),
		r.model,
	].filter(Boolean);
	return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Task file management
// ---------------------------------------------------------------------------

function ensureTaskFile(cwd: string, config: OrchestratorConfig, linearId: string | null, feature: string): string {
	const dir = path.join(cwd, config.taskFileDir);
	fs.mkdirSync(dir, { recursive: true });
	const safeFeature = feature.replace(/[^\w.-]+/g, "_").slice(0, 40);
	const id = linearId ?? `LOCAL-${Date.now().toString(36)}`;
	const file = path.join(dir, `task-${id}-${safeFeature}.md`);

	if (!fs.existsSync(file)) {
		const template = `# Task: ${id} — ${feature}

## Meta
- linear_id: ${linearId ?? "(none)"}
- tier: (pending)
- created: ${new Date().toISOString()}
- status: planning

## Brief
<!-- startproject が記入 -->

## Decision Log
<!-- 各フェーズが追記 -->

## Design
<!-- startproject (tier=M,L) が記入 -->

## Implementation Notes
<!-- team-implement が記入 -->

## Review
<!-- team-review が記入 -->

## Deploy
<!-- deploy が記入 -->
`;
		fs.writeFileSync(file, template, "utf-8");
	}
	return file;
}

function featureSlug(taskDescription: string): string {
	// Take first few meaningful words
	const words = taskDescription
		.replace(/[A-Z]+-\d+/g, "")
		.replace(/[^\w\s]/g, "")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 2)
		.slice(0, 4)
		.join("_");
	return words || "task";
}

function updateTaskFile(file: string, updates: Record<string, string>): void {
	let content = "";
	try {
		content = fs.readFileSync(file, "utf-8");
	} catch {
		return;
	}
	for (const [section, body] of Object.entries(updates)) {
		const re = new RegExp(`(## ${section}\\n)([\\s\\S]*?)(\\n## |$)`);
		if (re.test(content)) {
			content = content.replace(re, `$1${body}$3`);
		}
	}
	fs.writeFileSync(file, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

class BudgetTracker {
	totalCost = 0;
	phaseCosts: Record<string, number> = {};

	constructor(private config: OrchestratorConfig) {}

	add(phase: Phase, cost: number): void {
		this.totalCost += cost;
		this.phaseCosts[phase] = (this.phaseCosts[phase] ?? 0) + cost;
	}

	checkPhase(phase: Phase): { over: boolean; warn: boolean; msg: string } {
		const cost = this.phaseCosts[phase] ?? 0;
		const max = this.config.budget.maxCostPerPhase;
		const warn = this.config.budget.warnCostPerPhase;
		if (cost > max) return { over: true, warn: false, msg: `${phase} cost ${fmtCost(cost)} > max ${fmtCost(max)}` };
		if (cost > warn) return { over: false, warn: true, msg: `${phase} cost ${fmtCost(cost)} approaching max ${fmtCost(max)}` };
		return { over: false, warn: false, msg: "" };
	}

	checkTotal(): { over: boolean; msg: string } {
		if (this.totalCost > this.config.budget.maxTotalCost) {
			return { over: true, msg: `Total cost ${fmtCost(this.totalCost)} > budget ${fmtCost(this.config.budget.maxTotalCost)}` };
		}
		return { over: false, msg: "" };
	}
}

// ---------------------------------------------------------------------------
// Gate helpers
// ---------------------------------------------------------------------------

interface GateResult {
	approved: boolean;
	action: "continue" | "retry" | "abort";
}

async function gate1(ctx: any, config: OrchestratorConfig, planSummary: string): Promise<GateResult> {
	if (!config.gates.gate1 || config.gates.dontAsk) return { approved: true, action: "continue" };
	const ok = await ctx.ui.confirm(
		"Gate 1: 計画を承認しますか？",
		`startproject の計画:\n\n${planSummary}\n\n承認 → team-implement へ / 差し戻し → 計画修正`,
	);
	return ok ? { approved: true, action: "continue" } : { approved: false, action: "abort" };
}

async function gate3(ctx: any, config: OrchestratorConfig, reviewResult: PhaseResult, retryCount: number): Promise<GateResult> {
	if (!config.gates.gate3) return { approved: true, action: "continue" };
	if (config.gates.dontAsk && retryCount < config.gates.maxRetries) {
		return { approved: false, action: "retry" };
	}
	if (config.gates.dontAsk) {
		return { approved: true, action: "continue" };
	}
	const choice = await ctx.ui.select(
		"Gate 3: team-review が FAIL になりました",
		[
			"retry: team-implement に戻って修正して再実装",
			"continue: 指摘を無視して deploy へ進む",
			"abort: 終了",
		],
	);
	if (choice?.startsWith("retry")) return { approved: false, action: "retry" };
	if (choice?.startsWith("continue")) return { approved: true, action: "continue" };
	return { approved: false, action: "abort" };
}

// ---------------------------------------------------------------------------
// Review PASS/FAIL detection from phase result text
// ---------------------------------------------------------------------------

function reviewVerdict(result: PhaseResult): "PASS" | "FAIL" | "UNKNOWN" {
	const text = result.finalText + result.stderr;
	if (/判定:\s*PASS|### 判定:\s*PASS/i.test(text)) return "PASS";
	if (/判定:\s*FAIL|### 判定:\s*FAIL/i.test(text)) return "FAIL";
	return "UNKNOWN";
}

/**
 * レビュー指摘を実装タスクに埋め込んで、フィードバック付き再実装用のタスク文字列を構築する。
 * review の最終出力（指摘リスト）を抽出し、implement がそれを読んで修正できるようにする。
 */
function buildRetryTask(originalTask: string, reviewResult: PhaseResult, retryCount: number): string {
	const feedback = (reviewResult.finalText || reviewResult.stderr || "(レビュー出力なし)").slice(0, 6000);
	return `${originalTask}

---
## 前回の team-review での指摘（retry #${retryCount}）
以下の指摘をすべて修正してください。TASK_FILE の Review セクションも参照すること。

${feedback}
---`;
}

// ---------------------------------------------------------------------------
// Main orchestration flow
// ---------------------------------------------------------------------------

interface OrchestrationState {
	tier: Tier;
	linearId: string | null;
	taskFile: string;
	results: PhaseResult[];
	totalCost: number;
}

async function orchestrate(
	ctx: any,
	args: string,
	scope: "user" | "project" | "both",
): Promise<OrchestrationState> {
	const config = loadConfig();
	const parsed = parseOrchestrateArgs(args);
	const cwd = ctx.cwd;

	if (!parsed.taskDescription) {
		ctx.ui.notify("Usage: /orchestrate <task description or Linear ID>", "error");
		throw new Error("No task description");
	}

	// STEP 0: CLASSIFY
	const estimate = parsed.tier
		? { tier: parsed.tier, reason: `explicit --tier=${parsed.tier}`, fileTier: parsed.tier, complexityTier: parsed.tier, riskTier: parsed.tier, hardTrigger: false }
		: classifyTier(parsed.taskDescription);
	const tier = estimate.tier;
	const dontAsk = parsed.dontAsk || config.gates.dontAsk;
	if (dontAsk) config.gates.dontAsk = true;

	ctx.ui.notify(`Tier: ${tier} — ${estimate.reason}`, "info");

	// XS → suggest direct implementation and stop
	if (tier === "XS") {
		ctx.ui.notify("tier=XS: 直接実装を推奨。team-implement のみ実行します。", "info");
	}

	// STEP 1: LINEAR
	const linearId = detectLinearId(parsed.taskDescription, config);
	if (!linearId && config.linear.enabled) {
		const ans = await ctx.ui.input("Linear タスク ID または URL（未入力でスキップ）:");
		if (ans && ans.trim()) {
			const m = ans.trim().match(new RegExp(config.linear.idPattern));
			if (m) {
				// detected
			}
		}
	}

	// STEP 2: TASK FILE
	const feature = featureSlug(parsed.taskDescription);
	const taskFile = ensureTaskFile(cwd, config, linearId, feature);
	ctx.ui.notify(`Task file: ${taskFile}`, "info");
	updateTaskFile(taskFile, { Meta: `- linear_id: ${linearId ?? "(none)"}\n- tier: ${tier}\n- created: ${new Date().toISOString()}\n- status: planning` });

	// Setup
	const phases = phasesForTier(tier);
	const budget = new BudgetTracker(config);
	const results: PhaseResult[] = [];
	const taskArgs = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`;

	let implementResult: PhaseResult | null = null;
	let reviewResult: PhaseResult | null = null;

	// Execute phases sequentially
	for (const phase of phases) {
		const phaseModel = resolvePhaseModel(config, tier, phase);
		if (phaseModel.skipped) {
			ctx.ui.notify(`${phase}: skipped (tier=${tier})`, "info");
			continue;
		}

		ctx.ui.setStatus("orchestrator", `${phase} running (${phaseModel.model})...`);

		let result = await runPhase({
			cwd,
			scope,
			phase,
			agentName: phase,
			phaseModel,
			fallbackModel: config.fallbackModel,
			fallbackThinking: config.fallbackThinkingLevel,
			task: taskArgs,
			signal: ctx.signal,
			onUpdate: (text) => {
				ctx.ui.setStatus("orchestrator", `${phase}: ${text.slice(0, 80)}...`);
			},
		});

		budget.add(phase, result.usage.cost);
		results.push(result);

		ctx.ui.notify(summarizeResult(result), result.exitCode === 0 ? "info" : "warn");

		// Budget check
		const pc = budget.checkPhase(phase);
		if (pc.over) ctx.ui.notify(`⚠ Budget: ${pc.msg}`, "warn");
		else if (pc.warn) ctx.ui.notify(`Budget: ${pc.msg}`, "info");
		const tc = budget.checkTotal();
		if (tc.over) {
			ctx.ui.notify(`⚠ TOTAL BUDGET EXCEEDED: ${tc.msg}`, "error");
			const stop = await ctx.ui.confirm("予算超過", "続行しますか？");
			if (!stop) break;
		}

		// Gate 1: after startproject
		if (phase === "startproject") {
			const plan = result.finalText.slice(0, 500);
			const g1 = await gate1(ctx, config, plan);
			if (g1.action === "abort") {
				ctx.ui.notify("Gate 1 差し戻し: 終了します", "warn");
				break;
			}
		}

		// Track implement/review for Gate 3 retry
		if (phase === "team-implement") implementResult = result;
		if (phase === "team-review") reviewResult = result;

		// Gate 3: after team-review FAIL
		if (phase === "team-review") {
			const verdict = reviewVerdict(result);
			if (verdict === "FAIL") {
				let retryCount = 0;
				let g3 = await gate3(ctx, config, result, retryCount);
				while (g3.action === "retry" && retryCount < config.gates.maxRetries) {
					retryCount++;
					ctx.ui.notify(`Gate 3 retry ${retryCount}/${config.gates.maxRetries}: team-implement → team-review（レビュー指摘を反映）`, "info");

					// レビュー指摘を次の実装に引き継ぐ（フィードバック付き再実装）
					const retryTask = buildRetryTask(taskArgs, reviewResult, retryCount);

					// Re-run implement with review feedback
					const implModel = resolvePhaseModel(config, tier, "team-implement");
					implementResult = await runPhase({
						cwd, scope, phase: "team-implement", agentName: "team-implement",
						phaseModel: implModel, fallbackModel: config.fallbackModel, fallbackThinking: config.fallbackThinkingLevel,
						task: retryTask, signal: ctx.signal,
					});
					budget.add("team-implement", implementResult.usage.cost);

					// Re-run review（再実装されたコードを task-file から読み直して再判定）
					const revModel = resolvePhaseModel(config, tier, "team-review");
					reviewResult = await runPhase({
						cwd, scope, phase: "team-review", agentName: "team-review",
						phaseModel: revModel, fallbackModel: config.fallbackModel, fallbackThinking: config.fallbackThinkingLevel,
						task: taskArgs, signal: ctx.signal,
					});
					budget.add("team-review", reviewResult.usage.cost);
					results.push(implementResult, reviewResult);
					if (reviewVerdict(reviewResult) !== "FAIL") break;
					g3 = await gate3(ctx, config, reviewResult, retryCount);
				}
				if (g3.action === "abort") {
					ctx.ui.notify("Gate 3: 終了します", "warn");
					break;
				}
			}
		}

		ctx.ui.setStatus("orchestrator", "");
	}

	// STEP 7: completion report
	const totalCost = budget.totalCost;
	const report = formatReport(tier, linearId, taskFile, results, totalCost);
	ctx.ui.notify(report, "info");

	// Persist state to session
	try {
		(ctx as any).sessionManager?.appendEntry?.({
			type: "orchestrator_state",
			tier,
			linearId,
			taskFile,
			totalCost,
			phases: results.map((r) => r.phase),
		});
	} catch { /* best effort */ }

	return { tier, linearId, taskFile, results, totalCost };
}

function formatReport(tier: Tier, linearId: string | null, taskFile: string, results: PhaseResult[], totalCost: number): string {
	const lines = [
		`## 完了: orchestrate (tier=${tier})`,
		``,
		`- Linear: ${linearId ?? "(none)"}`,
		`- Task File: ${taskFile}`,
		`- Total cost: ${fmtCost(totalCost)}`,
		``,
		`### 各フェーズのサマリー`,
	];
	for (const r of results) {
		lines.push(`- ${summarizeResult(r)}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// /orchestrate command — interactive entry point
	pi.registerCommand("orchestrate", {
		description: "Project orchestrator — classify tier, route models per phase, run startproject → implement → review → deploy",
		handler: async (args: string, ctx: any) => {
			ctx.ui.notify("orchestrate 開始...", "info");
			try {
				const state = await orchestrate(ctx, args ?? "", "user");
				return;
			} catch (e: any) {
				ctx.ui.notify(`orchestrate error: ${e?.message ?? e}`, "error");
			}
		},
	});

	// orchestrate tool — callable by the LLM (e.g. via /orchestrate prompt template)
	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
			"Run the full project orchestration workflow (startproject → team-implement → team-review → deploy) with per-phase model routing, tier classification, gates, and budget control. Pass the task description (optionally with a Linear ID like NSKETCH-573).",
		parameters: Type.Object({
			task: Type.String({ description: "Task description, optionally including a Linear ID" }),
			tier: Type.Optional(Type.String({ description: "Override tier: XS | S | M | L. Auto-classified if omitted." })),
			dontAsk: Type.Optional(Type.Boolean({ description: "Auto-approve all gates. Default: false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const argStr = [params.task, params.tier ? `--tier=${params.tier}` : "", params.dontAsk ? "--dont-ask" : ""].filter(Boolean).join(" ");
			try {
				const state = await orchestrate(ctx, argStr, "user");
				const report = formatReport(state.tier, state.linearId, state.taskFile, state.results, state.totalCost);
				return {
					content: [{ type: "text", text: report }],
					details: { tier: state.tier, linearId: state.linearId, taskFile: state.taskFile, totalCost: state.totalCost },
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `orchestrate failed: ${e?.message ?? e}` }],
					details: {},
					isError: true,
				};
			}
		},
		promptSnippet: "Run the full orchestration workflow with per-phase model routing.",
		promptGuidelines: [
			"Use the orchestrate tool when the user asks to run the full project workflow (plan → implement → review → deploy) for a task or Linear issue.",
		],
	});

	// after_provider_response — detect 429 on the main session too (belt & suspenders)
	pi.on("after_provider_response", async (event: any, ctx: any) => {
		if (event.status === 429) {
			ctx.ui.notify("⚠ 429 rate limit on main session — consider /model to switch", "warn");
		}
	});

	// session_start — notify orchestrator is available
	pi.on("session_start", async (_event: any, ctx: any) => {
		const config = loadConfig();
		const tiers = Object.keys(config.tiers).join("/");
		ctx.ui.setStatus("orchestrator", `orchestrator ready (tiers: ${tiers})`);
	});
}
