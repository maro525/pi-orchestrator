/**
 * Orchestrator config loader, tier classifier, and model resolver.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "XS" | "S" | "M" | "L";
export type Phase = "startproject" | "team-implement" | "team-review" | "deploy";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TierModels {
	startproject: string | null;
	"team-implement": string | null;
	"team-review": string | null;
	deploy: string | null;
}

export interface OrchestratorConfig {
	tiers: Record<Tier, TierModels>;
	thinkingLevel: Partial<Record<Phase, ThinkingLevel>>;
	fallbackModel: string;
	fallbackThinkingLevel: ThinkingLevel;
	budget: {
		maxCostPerPhase: number;
		maxTotalCost: number;
		warnCostPerPhase: number;
	};
	gates: {
		gate1: boolean;
		gate3: boolean;
		dontAsk: boolean;
		maxRetries: number;
	};
	hardTriggers: string[];
	taskFileDir: string;
	linear: {
		enabled: boolean;
		idPattern: string;
	};
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: OrchestratorConfig = {
	tiers: {
		XS: { startproject: null, "team-implement": "", "team-review": null, deploy: "" },
		S: { startproject: "", "team-implement": "", "team-review": "", deploy: "" },
		M: { startproject: "", "team-implement": "", "team-review": "", deploy: "" },
		L: { startproject: "", "team-implement": "", "team-review": "", deploy: "" },
	},
	thinkingLevel: { startproject: "high", "team-implement": "medium", "team-review": "high", deploy: "low" },
	fallbackModel: "",
	fallbackThinkingLevel: "medium",
	budget: { maxCostPerPhase: 0.8, maxTotalCost: 3.0, warnCostPerPhase: 0.4 },
	gates: { gate1: true, gate3: true, dontAsk: false, maxRetries: 1 },
	hardTriggers: ["auth", "authentication", "db migration", "database migration", "payment", "billing", "public api", "core dependency", "schema change"],
	taskFileDir: ".claude/docs/decisions",
	linear: { enabled: true, idPattern: "[A-Z]+-[0-9]+" },
};

export function getConfigPath(): string {
	return path.join(getAgentDir(), "orchestrator.json");
}

export function loadConfig(): OrchestratorConfig {
	const configPath = getConfigPath();
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_CONFIG, ...parsed, tiers: { ...DEFAULT_CONFIG.tiers, ...parsed.tiers }, gates: { ...DEFAULT_CONFIG.gates, ...parsed.gates }, budget: { ...DEFAULT_CONFIG.budget, ...parsed.budget } };
	} catch {
		return DEFAULT_CONFIG;
	}
}

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

export interface TierEstimate {
	tier: Tier;
	reason: string;
	fileTier: Tier;
	complexityTier: Tier;
	riskTier: Tier;
	hardTrigger: boolean;
}

function tierRank(t: Tier): number {
	return { XS: 0, S: 1, M: 2, L: 3 }[t];
}

function rankToTier(r: number): Tier {
	return (["XS", "S", "M", "L"] as const)[Math.min(r, 3)] as Tier;
}

/**
 * Classify tier from a free-form task description.
 *
 * This is a heuristic estimate — the orchestrator command can also accept
 * an explicit `--tier=X` override.
 */
export function classifyTier(taskDescription: string): TierEstimate {
	const text = taskDescription.toLowerCase();

	// Hard triggers → force L
	const hardTrigger = (loadConfig().hardTriggers ?? []).some((kw) => text.includes(kw.toLowerCase()));
	if (hardTrigger) {
		return { tier: "L", reason: "Hard Trigger detected (auth/db/payment/api/deps)", fileTier: "L", complexityTier: "L", riskTier: "L", hardTrigger: true };
	}

	// File-tier heuristics (keywords)
	const fileKeywords: [string, Tier][] = [
		["migration", "M"],
		["refactor", "M"],
		["architecture", "L"],
		["new module", "M"],
		["new file", "S"],
		["typo", "XS"],
		["rename", "XS"],
		["config", "S"],
	];
	let fileTier: Tier = "XS";
	for (const [kw, t] of fileKeywords) {
		if (text.includes(kw)) fileTier = rankToTier(Math.max(tierRank(fileTier), tierRank(t as Tier)));
	}

	// Complexity heuristics
	let complexityTier: Tier = "XS";
	if (/(multi|parallel|concurrent|workflow|pipeline)/.test(text)) complexityTier = "M";
	if (/(integration|oauth|websocket|streaming)/.test(text)) complexityTier = "L";
	if (text.split(/\s+/).length > 40) complexityTier = rankToTier(Math.max(tierRank(complexityTier), 1));

	// Risk heuristics
	let riskTier: Tier = "XS";
	if (/(security|credential|secret|token)/.test(text)) riskTier = "L";
	else if (/(deploy|production|release)/.test(text)) riskTier = "M";
	else if (/(test|spec)/.test(text)) riskTier = "S";

	const tier = rankToTier(Math.max(tierRank(fileTier), tierRank(complexityTier), tierRank(riskTier)));
	return { tier, reason: `file=${fileTier} complexity=${complexityTier} risk=${riskTier} → max=${tier}`, fileTier, complexityTier, riskTier, hardTrigger: false };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export interface PhaseModel {
	model: string;
	thinkingLevel: ThinkingLevel;
	skipped: boolean;
}

export function resolvePhaseModel(config: OrchestratorConfig, tier: Tier, phase: Phase): PhaseModel {
	const tierModels = config.tiers[tier];
	const model = tierModels[phase];
	if (!model) {
		return { model: config.fallbackModel, thinkingLevel: config.fallbackThinkingLevel, skipped: true };
	}
	const thinking = config.thinkingLevel[phase] ?? config.fallbackThinkingLevel;
	return { model, thinkingLevel: thinking, skipped: false };
}

// ---------------------------------------------------------------------------
// Linear ID detection
// ---------------------------------------------------------------------------

export function detectLinearId(taskDescription: string, config: OrchestratorConfig): string | null {
	if (!config.linear.enabled) return null;
	const re = new RegExp(config.linear.idPattern);
	const m = taskDescription.match(re);
	return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface OrchestrateArgs {
	taskDescription: string;
	tier: Tier | null; // null = auto-classify
	dontAsk: boolean;
}

export function parseOrchestrateArgs(raw: string): OrchestrateArgs {
	let tier: Tier | null = null;
	let dontAsk = false;
	let rest = raw;

	const tierMatch = rest.match(/--tier=(XS|S|M|L)/i);
	if (tierMatch) {
		tier = tierMatch[1].toUpperCase() as Tier;
		rest = rest.replace(tierMatch[0], "").trim();
	}

	if (/--dont-ask\b|--no-ask\b/i.test(rest)) {
		dontAsk = true;
		rest = rest.replace(/--dont-ask\b|--no-ask\b/i, "").trim();
	}

	return { taskDescription: rest.trim(), tier, dontAsk };
}

// ---------------------------------------------------------------------------
// Phases that should run for a given tier
// ---------------------------------------------------------------------------

export function phasesForTier(tier: Tier): Phase[] {
	const all: Phase[] = ["startproject", "team-implement", "team-review", "deploy"];
	if (tier === "XS") return ["team-implement", "deploy"];
	return all;
}
