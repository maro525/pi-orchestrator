/**
 * Phase runner — spawns an isolated `pi` subprocess per phase,
 * parses JSON event stream, tracks usage, and handles 429 fallback.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import type { Phase, PhaseModel, ThinkingLevel } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseResult {
	phase: Phase;
	agent: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	stopReason?: string;
	errorMessage?: string;
	fallbackUsed: boolean;
	finalText: string;
}

export interface RunnerOptions {
	cwd: string;
	agentScope: "user" | "project" | "both";
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Agent loading (reuses subagent discovery, but we override the model)
// ---------------------------------------------------------------------------

function getAgent(cwd: string, scope: "user" | "project" | "both", name: string): AgentConfig | undefined {
	const { agents } = discoverAgents(cwd, scope);
	return agents.find((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// Prompt temp file
// ---------------------------------------------------------------------------

async function writePromptToTempFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orch-"));
	const safe = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safe}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

// ---------------------------------------------------------------------------
// pi invocation
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGeneric = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGeneric) return { command: process.execPath, args };
	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Build model spec string (provider/model[:thinking])
// ---------------------------------------------------------------------------

function modelSpec(model: string, thinking: ThinkingLevel): string {
	// pi --model accepts "provider/model:level" — but our config stores
	// full "provider/model" already. Append thinking level if not "off".
	if (thinking === "off") return model;
	return `${model}:${thinking}`;
}

// ---------------------------------------------------------------------------
// Spawn a single phase
// ---------------------------------------------------------------------------

async function spawnPhase(
	phase: Phase,
	agent: AgentConfig,
	phaseModel: PhaseModel,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (text: string) => void,
): Promise<PhaseResult> {
	const result: PhaseResult = {
		phase,
		agent: agent.name,
		model: phaseModel.model,
		thinkingLevel: phaseModel.thinkingLevel,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		fallbackUsed: false,
		finalText: "",
	};

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	args.push("--model", modelSpec(phaseModel.model, phaseModel.thinkingLevel));
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);
	}

	args.push(`Task: ${task}`);

	try {
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						const u = msg.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							result.usage.contextTokens = u.totalTokens || 0;
						}
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
						const text = getFinalText(msg);
						if (text) {
							result.finalText = text;
							onUpdate?.(text);
						}
					}
				}
				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error(`${phase} was aborted`);
		return result;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* */ }
	}
}

function getFinalText(msg: Message): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return "";
}

// ---------------------------------------------------------------------------
// 429 / error detection
// ---------------------------------------------------------------------------

function isRateLimited(result: PhaseResult): boolean {
	if (result.stopReason === "error" && /429|rate.?limit|too many requests/i.test(result.errorMessage || result.stderr)) return true;
	if (/429/.test(result.stderr)) return true;
	return false;
}

function isHardError(result: PhaseResult): boolean {
	return result.exitCode !== 0 && result.usage.turns === 0;
}

// ---------------------------------------------------------------------------
// Public: run a phase with fallback
// ---------------------------------------------------------------------------

export interface RunPhaseOptions {
	cwd: string;
	scope: "user" | "project" | "both";
	phase: Phase;
	agentName: string;
	phaseModel: PhaseModel;
	fallbackModel: string;
	fallbackThinking: ThinkingLevel;
	task: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}

export async function runPhase(opts: RunPhaseOptions): Promise<PhaseResult> {
	const agent = getAgent(opts.cwd, opts.scope, opts.agentName);
	if (!agent) {
		return {
			phase: opts.phase,
			agent: opts.agentName,
			model: opts.phaseModel.model,
			thinkingLevel: opts.phaseModel.thinkingLevel,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${opts.agentName}". Place agent .md in ~/.pi/agent/agents/`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			fallbackUsed: false,
			finalText: "",
			errorMessage: `Unknown agent: ${opts.agentName}`,
		};
	}

	// First attempt with configured model
	let result = await spawnPhase(opts.phase, agent, opts.phaseModel, opts.task, opts.cwd, opts.signal, opts.onUpdate);

	// Fallback on 429 or hard error
	if (isRateLimited(result) || isHardError(result)) {
		const fallbackPhaseModel: PhaseModel = {
			model: opts.fallbackModel,
			thinkingLevel: opts.fallbackThinking,
			skipped: false,
		};
		result = await spawnPhase(opts.phase, agent, fallbackPhaseModel, opts.task, opts.cwd, opts.signal, opts.onUpdate);
		result.fallbackUsed = true;
		result.model = opts.fallbackModel;
	}

	return result;
}
