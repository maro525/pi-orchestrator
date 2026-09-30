/**
 * Orchestrator extension.
 *
 * Code owns routing, gates, budget, fallback, and TASK_FILE writes.
 * Phase agents return an OUTPUT payload. They do not write TASK_FILE or post to Linear.
 * pi has no Linear MCP: a missing post is reported, never skipped silently.
 *
 * Markdown:
 *   ~/.pi/agent/agents/{startproject,team-implement,team-review,deploy}.md
 *   ~/.pi/agent/prompts/orchestrate.md
 *   ~/.pi/agent/orchestrator.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type OrchestratorConfig,
	type Phase,
	type Tier,
	classifyTier,
	detectLinearId,
	getConfigPath,
	loadConfig,
	parseOrchestrateArgs,
	resolvePhaseModel,
} from "./config.ts";
import { runPhase, type PhaseResult } from "./runner.ts";

function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function summarizeResult(r: PhaseResult): string {
	const status = r.exitCode === 0 ? "ok" : "fail";
	const parts = [
		`${status} ${r.phase}`,
		r.fallbackUsed ? "(fallback)" : "",
		`${r.usage.turns} turns`,
		`in ${fmtTokens(r.usage.input)}`,
		`out ${fmtTokens(r.usage.output)}`,
		fmtCost(r.usage.cost),
		r.model,
	].filter(Boolean);
	return parts.join(" | ");
}

function tierRank(t: Tier): number {
	return { XS: 0, S: 1, M: 2, L: 3 }[t];
}

function featureSlug(taskDescription: string): string {
	const words = taskDescription
		.replace(/[A-Z]+-\d+/g, "")
		.replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 1)
		.slice(0, 4)
		.join("_");
	const safe = words.replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
	return safe || "task";
}

function taskTemplate(id: string, title: string, linearId: string | null, tier: Tier): string {
	return `# Task: ${id} — ${title}

## Meta
- linear_id: ${linearId ?? "(none)"}
- tier: ${tier}
- created: ${new Date().toISOString()}
- status: planning
- branch:
- base:

## startproject
### Brief
<!-- orchestrator が startproject の返却 BRIEF から記入 -->

### Design
<!-- orchestrator が startproject の返却 DESIGN から記入 -->

### Plan
<!-- orchestrator が startproject の返却 PLAN から記入 -->

## team-implement
<!-- orchestrator が team-implement の返却 IMPLEMENTATION_NOTES から記入 -->

## team-review
<!-- orchestrator が team-review の返却 REVIEW から記入 -->

## deploy
<!-- orchestrator が deploy の返却 DEPLOY から記入 -->
`;
}

function ensureTaskFile(cwd: string, config: OrchestratorConfig, linearId: string | null, feature: string, title: string, tier: Tier): string {
	const dir = path.join(cwd, config.taskFileDir);
	fs.mkdirSync(dir, { recursive: true });
	const id = linearId ?? `LOCAL-${Date.now().toString(36)}`;
	const file = path.join(dir, `task-${id}-${feature}.md`);
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, taskTemplate(id, title, linearId, tier), "utf-8");
	}
	return file;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapH2(content: string, h2: string, fn: (body: string) => string): string {
	const re = new RegExp(`(## ${escapeRe(h2)}\\n)([\\s\\S]*?)(\\n## |$)`);
	const m = content.match(re);
	if (!m) return content;
	let next = fn(m[2]);
	if (!next.endsWith("\n")) next += "\n";
	return content.replace(re, (_all, open, _body, close) => `${open}${next}${close}`);
}

function setMetaFields(content: string, fields: Record<string, string>): string {
	return mapH2(content, "Meta", (body) => {
		let next = body;
		for (const [key, value] of Object.entries(fields)) {
			const line = `- ${key}: ${value}`;
			const re = new RegExp(`^- ${escapeRe(key)}:.*$`, "m");
			if (re.test(next)) next = next.replace(re, () => line);
			else next = `${line}\n${next}`;
		}
		return next;
	});
}

function setH3(content: string, h2: string, h3: string, body: string): string {
	const block = `${body.trim()}\n`;
	return mapH2(content, h2, (section) => {
		const h3re = new RegExp(`(### ${escapeRe(h3)}\\n)[\\s\\S]*?(?=\\n### |$)`);
		if (h3re.test(section)) return section.replace(h3re, (_all, open) => `${open}${block}`);
		return `${section.replace(/\s*$/, "")}\n\n### ${h3}\n${block}`;
	});
}

function setH2Body(content: string, h2: string, body: string): string {
	return mapH2(content, h2, () => `${body.trim()}\n`);
}

function appendRound(content: string, h2: string, body: string): string {
	return mapH2(content, h2, (section) => {
		const n = (section.match(/^### \d+回目/gm) ?? []).length + 1;
		return `${section.replace(/\s*$/, "")}\n\n### ${n}回目\n${body.trim()}\n`;
	});
}

function setLinearComment(content: string, h2: string, comment: string): string {
	const block = `<!-- linear-comment\n${comment.trim()}\n-->\n`;
	return mapH2(content, h2, (body) => {
		const stripped = body.replace(/<!-- linear-comment\n[\s\S]*?-->\n?/, "");
		return block + stripped.replace(/^\n/, "");
	});
}

function readTask(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function writeTask(ctx: any, file: string, content: string): boolean {
	try {
		fs.writeFileSync(file, content, "utf-8");
		return true;
	} catch (e: any) {
		ctx.ui.notify(`TASK_FILE の書き込みに失敗しました: ${file} (${e?.message ?? e})`, "error");
		return false;
	}
}

function mutateTask(ctx: any, file: string, fn: (content: string) => string): boolean {
	const cur = readTask(file);
	if (cur == null) {
		ctx.ui.notify(`TASK_FILE を読めません: ${file}`, "error");
		return false;
	}
	return writeTask(ctx, file, fn(cur));
}

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

function parseSections(text: string): Record<string, string> {
	let src = text.trim();
	const fence = src.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
	if (fence) src = fence[1];
	const re = /^### ([A-Z][A-Z0-9_]*)\s*$/gm;
	const matches = [...src.matchAll(re)];
	const out: Record<string, string> = {};
	for (let i = 0; i < matches.length; i++) {
		const name = matches[i][1];
		const start = (matches[i].index ?? 0) + matches[i][0].length;
		const end = i + 1 < matches.length ? (matches[i + 1].index ?? src.length) : src.length;
		out[name] = src.slice(start, end).trim();
	}
	return out;
}

function hasSections(sections: Record<string, string>, required: string[]): boolean {
	return required.every((name) => (sections[name] ?? "").trim().length > 0);
}

function gate1Token(raw: string | undefined): "auto-approved" | "approved" | "revised" | "needs-approval" {
	const v = (raw ?? "").trim().toLowerCase();
	const first = v.split(/[\s|]+/).filter(Boolean)[0] ?? "";
	if (!v || (v.includes("auto") && v.includes("need"))) return "needs-approval";
	if (first === "auto-approved" || first === "auto") return "auto-approved";
	if (first === "approved") return "approved";
	if (first === "revised") return "revised";
	return "needs-approval";
}

function verdictOf(sections: Record<string, string>): "PASS" | "FAIL" | "UNKNOWN" {
	const raw = (sections.VERDICT ?? "").trim().toUpperCase();
	const hasPass = /\bPASS\b/.test(raw);
	const hasFail = /\bFAIL\b/.test(raw);
	if (hasPass === hasFail) return "UNKNOWN";
	return hasPass ? "PASS" : "FAIL";
}

function parseEscalation(raw: string | undefined): { tier: Tier; reason: string } | null {
	if (!raw?.trim()) return null;
	const m = raw.match(/(?:^|\n)(S|M|L)\s*[:：]\s*([^\n]+)/);
	if (!m) return null;
	return { tier: m[1] as Tier, reason: m[2].trim() };
}

function firstLine(raw: string | undefined): string {
	return (raw ?? "").split("\n")[0]?.trim() ?? "";
}

function planSummary(sections: Record<string, string>, fallback: string): string {
	const design = sections.DESIGN?.trim();
	const plan = sections.PLAN?.trim();
	const text = [design && `方針:\n${design}`, plan && `計画:\n${plan}`].filter(Boolean).join("\n\n");
	return (text || fallback || "(計画本文なし)").slice(0, 2500);
}

function buildRetryTask(originalTask: string, reviewText: string, retryCount: number): string {
	const feedback = (reviewText || "(レビュー出力なし)").slice(0, 6000);
	return `${originalTask}

---
前回の team-review（retry #${retryCount}）の指摘です。critical / major をすべて修正してください。TASK_FILE の ## team-review 最新回も参照すること。コミットはしないこと。

${feedback}
---`;
}

interface OrchestrationState {
	tier: Tier;
	linearId: string | null;
	taskFile: string;
	results: PhaseResult[];
	totalCost: number;
	report: string;
}

interface RunCtx {
	ctx: any;
	cwd: string;
	scope: "user" | "project" | "both";
	config: OrchestratorConfig;
	budget: BudgetTracker;
	results: PhaseResult[];
	linearNotes: string[];
	totalOverConfirmed: boolean;
}

async function executePhase(
	rc: RunCtx,
	phase: Phase,
	tier: Tier,
	task: string,
	required: string[],
): Promise<{ result: PhaseResult; sections: Record<string, string>; ok: boolean; stopped: boolean }> {
	const phaseModel = resolvePhaseModel(rc.config, tier, phase);
	if (phaseModel.skipped) {
		rc.ctx.ui.notify(`${phase}: model が null です (tier=${tier})。中断します。`, "error");
		return { result: emptyResult(phase), sections: {}, ok: false, stopped: true };
	}

	const runOnce = async (prompt: string): Promise<PhaseResult> => {
		rc.ctx.ui.setStatus("orchestrator", `${phase} running (${phaseModel.model})...`);
		const result = await runPhase({
			cwd: rc.cwd,
			scope: rc.scope,
			phase,
			agentName: phase,
			phaseModel,
			fallbackModel: rc.config.fallbackModel,
			fallbackThinking: rc.config.fallbackThinkingLevel,
			task: prompt,
			signal: rc.ctx.signal,
			onUpdate: (text) => {
				rc.ctx.ui.setStatus("orchestrator", `${phase}: ${text.slice(0, 80)}`);
			},
		});
		rc.budget.add(phase, result.usage.cost);
		rc.results.push(result);
		rc.ctx.ui.notify(summarizeResult(result), result.exitCode === 0 ? "info" : "warn");
		return result;
	};

	let result = await runOnce(task);
	let sections = parseSections(result.finalText);
	const escalating = phase === "team-implement" && parseEscalation(sections.ESCALATION);
	if (result.exitCode === 0 && !escalating && !hasSections(sections, required)) {
		rc.ctx.ui.notify(`${phase}: OUTPUT が不足しています。整形し直します。`, "warn");
		const retryTask = `前回の応答が OUTPUT フォーマットに従っていません。必須セクション: ${required.join(", ")}。そのフォーマットだけを返してください。\n\n元タスク:\n${task.slice(0, 4000)}\n\n前回の応答:\n${result.finalText.slice(0, 8000)}`;
		result = await runOnce(retryTask);
		sections = parseSections(result.finalText);
	}

	const pc = rc.budget.checkPhase(phase);
	if (pc.over) rc.ctx.ui.notify(`Budget: ${pc.msg}`, "warn");
	else if (pc.warn) rc.ctx.ui.notify(`Budget: ${pc.msg}`, "info");
	const tc = rc.budget.checkTotal();
	if (tc.over && !rc.totalOverConfirmed) {
		rc.ctx.ui.notify(`TOTAL BUDGET EXCEEDED: ${tc.msg}`, "error");
		const cont = await rc.ctx.ui.confirm("予算超過", "続行しますか？");
		if (!cont) return { result, sections, ok: false, stopped: true };
		rc.totalOverConfirmed = true;
	}

	rc.ctx.ui.setStatus("orchestrator", "");
	if (result.exitCode !== 0) {
		rc.ctx.ui.notify(`${phase} が失敗しました。次のフェーズには進みません。`, "error");
		return { result, sections, ok: false, stopped: true };
	}
	if (!escalating && !hasSections(sections, required)) {
		rc.ctx.ui.notify(`${phase}: 必須セクションがありません (${required.join(", ")})。中断します。`, "error");
		return { result, sections, ok: false, stopped: true };
	}
	return { result, sections, ok: true, stopped: false };
}

function emptyResult(phase: Phase): PhaseResult {
	return {
		phase,
		agent: phase,
		model: "",
		thinkingLevel: "off",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		fallbackUsed: false,
		finalText: "",
		errorMessage: "skipped",
	};
}

function reportLinear(rc: RunCtx, phase: string, linearId: string | null, comment: string | undefined): void {
	if (!rc.config.linear.enabled) return;
	if (!comment?.trim()) {
		rc.ctx.ui.notify(`${phase}: LINEAR_COMMENT が空です。Linear へは投稿していません。`, "warn");
		rc.linearNotes.push(`- ${phase}: (empty)`);
		return;
	}
	rc.linearNotes.push(`### ${phase}\n${comment.trim()}`);
	const id = linearId ?? "(no id)";
	rc.ctx.ui.notify(`${phase}: Linear (${id}) へは未投稿です。pi は Linear MCP 非対応。本文は完了報告と TASK_FILE に残しています。`, "warn");
}

function noteLinearStatus(rc: RunCtx, linearId: string | null, status: string): void {
	if (!rc.config.linear.enabled) return;
	const id = linearId ?? "(no id)";
	rc.linearNotes.push(`- ${id} status: ${status}`);
	rc.ctx.ui.notify(`Linear (${id}) のステータスを "${status}" に変更できません。手動で変更してください。`, "warn");
}

function persistLinear(ctx: any, file: string, h2: string, comment: string | undefined): boolean {
	if (!comment?.trim()) return true;
	return mutateTask(ctx, file, (content) => setLinearComment(content, h2, comment));
}

async function resolveGate1(
	ctx: any,
	config: OrchestratorConfig,
	sections: Record<string, string>,
	fallback: string,
	revisions: number,
): Promise<"auto-approved" | "approved" | "revised" | "abort" | "revise"> {
	const token = gate1Token(sections.GATE1);
	if (!config.gates.gate1 || config.gates.dontAsk) {
		return revisions > 0 ? "revised" : "auto-approved";
	}
	if (token !== "needs-approval") return token;
	const ok = await ctx.ui.confirm(
		"Gate 1: 計画を承認しますか？",
		`${planSummary(sections, fallback)}\n\n承認 → team-implement へ / 拒否 → 計画を差し戻す`,
	);
	if (ok) return revisions > 0 ? "revised" : "approved";
	return "revise";
}

async function gate2(ctx: any, config: OrchestratorConfig, retryCount: number): Promise<"retry" | "abort"> {
	if (!config.gates.gate2) return "abort";
	if (retryCount >= config.gates.maxRetries) {
		ctx.ui.notify(`Gate 2: 再実装の上限 (${config.gates.maxRetries}) に達しました。deploy しません。`, "warn");
		return "abort";
	}
	if (config.gates.dontAsk) return "retry";
	const choice = await ctx.ui.select("Gate 2: team-review が FAIL です", [
		"retry: team-implement に戻して修正する",
		"abort: 終了する（deploy しない）",
	]);
	if (choice?.startsWith("retry")) return "retry";
	return "abort";
}

async function orchestrate(ctx: any, args: string, scope: "user" | "project" | "both"): Promise<OrchestrationState> {
	const config = loadConfig();
	const parsed = parseOrchestrateArgs(args);
	const cwd = ctx.cwd;
	const linearNotes: string[] = [];
	const results: PhaseResult[] = [];
	const budget = new BudgetTracker(config);
	let gate1Outcome = "n/a";
	let verdict: "PASS" | "FAIL" | "UNKNOWN" | "n/a" = "n/a";
	let aborted = "";

	const finish = (tier: Tier, linearId: string | null, taskFile: string): OrchestrationState => {
		const report = formatReport({
			title: parsed.taskDescription || "(no task)",
			tier,
			linearId,
			taskFile,
			results,
			totalCost: budget.totalCost,
			gate1: gate1Outcome,
			verdict,
			aborted,
			linearNotes,
		});
		ctx.ui.notify(report, aborted ? "warn" : "info");
		try {
			(ctx as any).sessionManager?.appendEntry?.({
				type: "orchestrator_state",
				tier,
				linearId,
				taskFile,
				totalCost: budget.totalCost,
				phases: results.map((r) => r.phase),
			});
		} catch { /* best effort */ }
		return { tier, linearId, taskFile, results, totalCost: budget.totalCost, report };
	};

	if (!parsed.taskDescription) {
		ctx.ui.notify("Usage: /orchestrate <task description or Linear ID>", "error");
		throw new Error("No task description");
	}

	const estimate = parsed.tier
		? { tier: parsed.tier, reason: `explicit --tier=${parsed.tier}` }
		: classifyTier(parsed.taskDescription);
	let tier = estimate.tier;
	if (parsed.dontAsk || config.gates.dontAsk) config.gates.dontAsk = true;

	ctx.ui.notify(`Tier: ${tier} — ${estimate.reason}`, "info");

	if (tier === "XS") {
		const report = `## tier=XS\n\n/orchestrate は使いません。直接実装してください。\n\n- 判定: ${estimate.reason}`;
		ctx.ui.notify(report, "info");
		return { tier, linearId: detectLinearId(parsed.taskDescription, config), taskFile: "", results, totalCost: 0, report };
	}

	let linearId = detectLinearId(parsed.taskDescription, config);
	if (!linearId && config.linear.enabled && !config.gates.dontAsk) {
		const ans = await ctx.ui.input("Linear タスク ID または URL（空欄でスキップ）:");
		const m = ans?.trim().match(new RegExp(config.linear.idPattern));
		if (m) linearId = m[0];
		else if (ans?.trim()) ctx.ui.notify(`Linear ID を検出できませんでした (${ans.trim()})。LOCAL ID で続行し、投稿できない旨を報告します。`, "warn");
		else ctx.ui.notify("Linear ID なし。LOCAL ID で続行します。", "info");
	} else if (!linearId && config.linear.enabled) {
		ctx.ui.notify("Linear ID なし（dont-ask）。LOCAL ID で続行します。", "info");
	}

	const title = parsed.taskDescription.replace(/\s+/g, " ").trim().slice(0, 80);
	const taskFile = ensureTaskFile(cwd, config, linearId, featureSlug(parsed.taskDescription), title, tier);
	ctx.ui.notify(`Task file: ${taskFile}`, "info");
	if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { tier, status: "planning" }))) {
		aborted = "TASK_FILE を更新できませんでした。";
		return finish(tier, linearId, taskFile);
	}

	const rc: RunCtx = { ctx, cwd, scope, config, budget, results, linearNotes, totalOverConfirmed: false };
	const baseTask = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`;

	const runnable = (["startproject", "team-implement", "team-review", "deploy"] as Phase[]).filter((p) => {
		const m = config.tiers[tier][p];
		return typeof m === "string" && m.trim().length > 0;
	});
	if (!runnable.includes("startproject")) {
		const msg = `startproject の model がありません (tier=${tier})。計画なしでは実装しません。\n${getConfigPath()}`;
		ctx.ui.notify(msg, "error");
		throw new Error(msg);
	}

	let taskArgs = baseTask;
	let revisions = 0;
	while (true) {
		const planned = await executePhase(rc, "startproject", tier, taskArgs, ["BRIEF", "DESIGN", "PLAN"]);
		if (!planned.ok) {
			aborted = aborted || "startproject が完了しませんでした。";
			return finish(tier, linearId, taskFile);
		}
		const wrote = mutateTask(ctx, taskFile, (c) => {
			let next = setH3(c, "startproject", "Brief", planned.sections.BRIEF ?? "");
			next = setH3(next, "startproject", "Design", planned.sections.DESIGN ?? "");
			next = setH3(next, "startproject", "Plan", planned.sections.PLAN ?? "");
			return next;
		});
		if (!wrote || !persistLinear(ctx, taskFile, "startproject", planned.sections.LINEAR_COMMENT)) {
			aborted = "計画の書き込みに失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		reportLinear(rc, "startproject", linearId, planned.sections.LINEAR_COMMENT);

		const g1 = await resolveGate1(ctx, config, planned.sections, planned.result.finalText, revisions);
		if (g1 === "revise") {
			revisions++;
			if (revisions > 2) {
				aborted = "Gate 1: 差し戻し上限に達したため終了します。";
				ctx.ui.notify(aborted, "warn");
				return finish(tier, linearId, taskFile);
			}
			const feedback = (await ctx.ui.input("差し戻し理由（計画に反映します）:"))?.trim() || "方針を見直して再提出してください。";
			taskArgs = `${baseTask}\n\n---\n前回の計画は差し戻されました。フィードバックを反映し、GATE1 を判断し直してください。\n\n${feedback}\n---`;
			continue;
		}
		if (g1 === "abort") {
			aborted = "Gate 1 で終了しました。";
			return finish(tier, linearId, taskFile);
		}
		gate1Outcome = g1;
		break;
	}

	let escalations = 0;
	noteLinearStatus(rc, linearId, "In Progress");
	while (true) {
		if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "implementing", tier }))) {
			aborted = "status の更新に失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		const implTask = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`;
		const impl = await executePhase(rc, "team-implement", tier, implTask, ["IMPLEMENTATION_NOTES", "BRANCH", "BASE"]);
		if (!impl.ok) {
			aborted = aborted || "team-implement が完了しませんでした。";
			return finish(tier, linearId, taskFile);
		}
		const esc = parseEscalation(impl.sections.ESCALATION);
		const branch = firstLine(impl.sections.BRANCH);
		const base = firstLine(impl.sections.BASE);
		const notes = impl.sections.IMPLEMENTATION_NOTES?.trim();
		const wrote = mutateTask(ctx, taskFile, (c) => {
			let next = c;
			if (branch || base) next = setMetaFields(next, { ...(branch ? { branch } : {}), ...(base ? { base } : {}) });
			if (notes) next = appendRound(next, "team-implement", notes);
			return next;
		});
		if (!wrote || !persistLinear(ctx, taskFile, "team-implement", impl.sections.LINEAR_COMMENT)) {
			aborted = "実装結果の書き込みに失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		reportLinear(rc, "team-implement", linearId, impl.sections.LINEAR_COMMENT);

		if (!esc) break;
		if (tierRank(esc.tier) <= tierRank(tier)) {
			ctx.ui.notify(`ESCALATION が現在の tier 以下です (${esc.tier})。無視して続行します。`, "warn");
			break;
		}
		escalations++;
		if (escalations > 2) {
			aborted = "エスカレーション上限に達したため終了します。作業ブランチの変更はそのままです。";
			ctx.ui.notify(aborted, "warn");
			return finish(tier, linearId, taskFile);
		}
		ctx.ui.notify(`Escalation: ${tier} → ${esc.tier} — ${esc.reason}`, "warn");
		tier = esc.tier;
		if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { tier, status: "implementing" }))) {
			aborted = "tier の更新に失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		taskArgs = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}\n\n---\n実装中に tier を ${tier} へ引き上げました。理由: ${esc.reason}\n作業ブランチ上の変更はやり直さず、計画だけ更新してください。\n---`;
		revisions = 0;
		let replanned = false;
		while (!replanned) {
			const planned = await executePhase(rc, "startproject", tier, taskArgs, ["BRIEF", "DESIGN", "PLAN"]);
			if (!planned.ok) {
				aborted = "エスカレーション後の startproject が完了しませんでした。";
				return finish(tier, linearId, taskFile);
			}
			const planWrote = mutateTask(ctx, taskFile, (c) => {
				let next = setH3(c, "startproject", "Brief", planned.sections.BRIEF ?? "");
				next = setH3(next, "startproject", "Design", planned.sections.DESIGN ?? "");
				next = setH3(next, "startproject", "Plan", planned.sections.PLAN ?? "");
				return next;
			});
			if (!planWrote || !persistLinear(ctx, taskFile, "startproject", planned.sections.LINEAR_COMMENT)) {
				aborted = "再計画の書き込みに失敗しました。";
				return finish(tier, linearId, taskFile);
			}
			reportLinear(rc, "startproject", linearId, planned.sections.LINEAR_COMMENT);
			const g1 = await resolveGate1(ctx, config, planned.sections, planned.result.finalText, revisions);
			if (g1 === "revise") {
				revisions++;
				if (revisions > 2) {
					aborted = "Gate 1: 差し戻し上限に達したため終了します。";
					return finish(tier, linearId, taskFile);
				}
				const feedback = (await ctx.ui.input("差し戻し理由（計画に反映します）:"))?.trim() || "方針を見直して再提出してください。";
				taskArgs = `${taskArgs}\n\n---\n再計画は差し戻されました。\n\n${feedback}\n---`;
				continue;
			}
			gate1Outcome = g1;
			replanned = true;
		}
	}

	if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "reviewing" }))) {
		aborted = "status の更新に失敗しました。";
		return finish(tier, linearId, taskFile);
	}

	let retryCount = 0;
	let reviewTask = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`;
	while (true) {
		const rev = await executePhase(rc, "team-review", tier, reviewTask, ["VERDICT", "REVIEW"]);
		if (!rev.ok) {
			aborted = aborted || "team-review が完了しませんでした。";
			return finish(tier, linearId, taskFile);
		}
		verdict = verdictOf(rev.sections);
		const reviewBody = rev.sections.REVIEW?.trim() || rev.result.finalText.slice(0, 4000);
		if (!mutateTask(ctx, taskFile, (c) => appendRound(c, "team-review", `Verdict: ${verdict}\n\n${reviewBody}`))) {
			aborted = "レビュー結果の書き込みに失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		if (!persistLinear(ctx, taskFile, "team-review", rev.sections.LINEAR_COMMENT)) {
			aborted = "レビューコメントの書き込みに失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		reportLinear(rc, "team-review", linearId, rev.sections.LINEAR_COMMENT);

		if (verdict === "PASS") break;
		if (verdict === "UNKNOWN") {
			aborted = "VERDICT を判定できません。deploy しません。";
			ctx.ui.notify(aborted, "error");
			return finish(tier, linearId, taskFile);
		}
		const action = await gate2(ctx, config, retryCount);
		if (action === "abort") {
			aborted = "Gate 2: FAIL のため deploy せず終了します。";
			ctx.ui.notify(aborted, "warn");
			return finish(tier, linearId, taskFile);
		}
		retryCount++;
		ctx.ui.notify(`Gate 2 retry ${retryCount}/${config.gates.maxRetries}: team-implement に戻します`, "info");
		if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "implementing" }))) {
			aborted = "status の更新に失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		const retryImpl = await executePhase(
			rc,
			"team-implement",
			tier,
			buildRetryTask(reviewTask, rev.result.finalText, retryCount),
			["IMPLEMENTATION_NOTES", "BRANCH", "BASE"],
		);
		if (!retryImpl.ok) {
			aborted = "差し戻し後の team-implement が完了しませんでした。";
			return finish(tier, linearId, taskFile);
		}
		if (parseEscalation(retryImpl.sections.ESCALATION)) {
			aborted = "差し戻し中に ESCALATION が返りました。作業ブランチは残しています。新しい tier で /orchestrate をやり直してください。";
			ctx.ui.notify(aborted, "warn");
			return finish(tier, linearId, taskFile);
		}
		const notes = retryImpl.sections.IMPLEMENTATION_NOTES?.trim();
		if (notes && !mutateTask(ctx, taskFile, (c) => appendRound(c, "team-implement", notes))) {
			aborted = "再実装結果の書き込みに失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		reportLinear(rc, "team-implement", linearId, retryImpl.sections.LINEAR_COMMENT);
		persistLinear(ctx, taskFile, "team-implement", retryImpl.sections.LINEAR_COMMENT);
		if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "reviewing" }))) {
			aborted = "status の更新に失敗しました。";
			return finish(tier, linearId, taskFile);
		}
		reviewTask = `${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`;
	}

	if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "deploying" }))) {
		aborted = "status の更新に失敗しました。";
		return finish(tier, linearId, taskFile);
	}
	const dep = await executePhase(
		rc,
		"deploy",
		tier,
		`${parsed.taskDescription} --tier=${tier} --task-file=${taskFile} --linear-id=${linearId ?? "none"}`,
		["DEPLOY"],
	);
	if (!dep.ok) {
		aborted = aborted || "deploy が完了しませんでした。";
		return finish(tier, linearId, taskFile);
	}
	if (!mutateTask(ctx, taskFile, (c) => setH2Body(c, "deploy", dep.sections.DEPLOY ?? ""))) {
		aborted = "deploy 結果の書き込みに失敗しました。";
		return finish(tier, linearId, taskFile);
	}
	if (!persistLinear(ctx, taskFile, "deploy", dep.sections.LINEAR_COMMENT)) {
		aborted = "deploy コメントの書き込みに失敗しました。";
		return finish(tier, linearId, taskFile);
	}
	reportLinear(rc, "deploy", linearId, dep.sections.LINEAR_COMMENT);
	noteLinearStatus(rc, linearId, "In Review");
	if (!mutateTask(ctx, taskFile, (c) => setMetaFields(c, { status: "in-review" }))) {
		aborted = "status を in-review にできませんでした。";
		return finish(tier, linearId, taskFile);
	}

	return finish(tier, linearId, taskFile);
}

function formatReport(input: {
	title: string;
	tier: Tier;
	linearId: string | null;
	taskFile: string;
	results: PhaseResult[];
	totalCost: number;
	gate1: string;
	verdict: string;
	aborted: string;
	linearNotes: string[];
}): string {
	const lines = [
		`## ${input.aborted ? "中断" : "完了"}: ${input.title}`,
		``,
		`- Linear: ${input.linearId ?? "(none)"}`,
		`- Tier: ${input.tier}`,
		`- Task File: ${input.taskFile || "(none)"}`,
		`- Gate 1: ${input.gate1}`,
		`- Review: ${input.verdict}`,
		`- Total cost: ${fmtCost(input.totalCost)}`,
	];
	if (input.aborted) lines.push(`- 停止理由: ${input.aborted}`);
	lines.push(``, `### 各フェーズのサマリー`);
	if (input.results.length === 0) lines.push("- (フェーズ未実行)");
	for (const r of input.results) lines.push(`- ${summarizeResult(r)}`);
	if (input.linearNotes.length > 0) {
		lines.push(``, `### Linear（未投稿。pi は Linear MCP 非対応）`, ...input.linearNotes);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("orchestrate", {
		description: "Classify tier, then startproject → team-implement → team-review → deploy. Orchestrator writes the task file.",
		handler: async (args: string, ctx: any) => {
			ctx.ui.notify("orchestrate 開始...", "info");
			try {
				await orchestrate(ctx, args ?? "", "user");
			} catch (e: any) {
				ctx.ui.notify(`orchestrate error: ${e?.message ?? e}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
			"Run startproject → team-implement → team-review → deploy. Phase agents return payloads; this tool writes the task file, applies Gate 1/Gate 2, and does not post to Linear (that failure is reported).",
		parameters: Type.Object({
			task: Type.String({ description: "Task description, optionally including a Linear ID" }),
			tier: Type.Optional(Type.String({ description: "Override tier: XS | S | M | L. Auto-classified if omitted." })),
			dontAsk: Type.Optional(Type.Boolean({ description: "Auto-approve Gate 1 and auto-retry Gate 2. Default: false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const argStr = [params.task, params.tier ? `--tier=${params.tier}` : "", params.dontAsk ? "--dont-ask" : ""].filter(Boolean).join(" ");
			try {
				const state = await orchestrate(ctx, argStr, "user");
				return {
					content: [{ type: "text", text: state.report }],
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
		promptSnippet: "Run the project workflow. XS is refused. FAIL does not deploy.",
		promptGuidelines: [
			"Use orchestrate for S/M/L work that should go plan → implement → review → deploy. Do not use it for XS (one file, no logic change).",
		],
	});

	pi.on("after_provider_response", async (event: any, ctx: any) => {
		if (event.status === 429) {
			ctx.ui.notify("429 rate limit on main session — consider /model to switch", "warn");
		}
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		const config = loadConfig();
		const tiers = Object.keys(config.tiers).join("/");
		ctx.ui.setStatus("orchestrator", `orchestrator ready (tiers: ${tiers})`);
	});
}
