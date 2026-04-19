import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	buildActionAgentSystemPrompt,
	buildContextCompactorSystemPrompt,
	buildCriticSystemPrompt,
	buildIntegratorSystemPrompt,
	buildVerifierSystemPrompt,
	buildWorkerSystemPrompt,
	CRITIC_ROLES,
	DEFAULT_CRITIC_COUNT,
	DEFAULT_MODEL,
	DEFAULT_WORKER_COUNT,
	type ProStrategy,
	type ProTaskMode,
	WORKER_ROLES,
} from "./prompts.js";
import { BENCHMARK_CASES, type BenchmarkCase } from "./benchmarks.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MAX_WORKERS = 12;
const MAX_CRITICS = 4;
const MAX_CONCURRENCY = 10;
const COPY_SKIP_NAMES = new Set([
	".git",
	".pi",
	"node_modules",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
]);

type RunStage = "context" | "worker" | "critic" | "integrator" | "action" | "verifier";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RuntimeRunResult {
	id: string;
	label: string;
	stage: RunStage;
	role: string;
	cwd: string;
	workspacePath?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	startedAt: number;
	endedAt?: number;
	lastActivityAt?: number;
	lastActivity?: string;
}

interface ResultSummary {
	id: string;
	label: string;
	stage: RunStage;
	role: string;
	cwd: string;
	workspacePath?: string;
	exitCode: number;
	preview: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface ProRunReport {
	mode: ProTaskMode;
	strategy: ProStrategy;
	model: string;
	task: string;
	workerCount: number;
	criticCount: number;
	isolatedWorkspaces: boolean;
	results: ResultSummary[];
	finalText: string;
	startedAt: number;
	endedAt: number;
	totalCost: number;
	expectedRuns: number;
	contextMessageCount: number;
}

interface BenchmarkStrategyResult {
	strategy: ProStrategy;
	passed: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	report: ProRunReport;
}

interface BenchmarkCaseResult {
	caseId: string;
	title: string;
	strategies: BenchmarkStrategyResult[];
}

interface BenchmarkReport {
	startedAt: number;
	endedAt: number;
	results: BenchmarkCaseResult[];
}

interface ChildRunSpec {
	id: string;
	label: string;
	stage: RunStage;
	role: string;
	cwd: string;
	workspacePath?: string;
	model: string;
	tools: string[];
	systemPrompt: string;
	task: string;
}

interface ProRunParams {
	task: string;
	mode: ProTaskMode;
	strategy: ProStrategy;
	workerCount: number;
	criticCount: number;
	model: string;
	isolatedWorkspaces: boolean;
	yolo: boolean;
	source: "command" | "tool";
}

interface SessionContextData {
	fullThread: string;
	recentTurns: string;
	latestUserMessage: string;
	messageCount: number;
}

interface DurableConstraint {
	source: string;
	constraint: string;
	superseded_by?: string | null;
}

interface ContextBrief {
	task_focus?: {
		current_request?: string;
		scope?: string;
	};
	durable_constraints?: DurableConstraint[];
	decisions_made?: Array<{ decision?: string; source?: string }>;
	decisions_rejected?: Array<{ rejected?: string; reason?: string; source?: string }>;
	known_state?: string[];
	artifacts?: {
		files_mentioned?: string[];
		commands_mentioned?: string[];
		external_refs?: string[];
	};
	open_questions?: string[];
	meta?: {
		variant?: string;
		omitted_on_purpose?: string[];
	};
}

interface StructuredPlanFile {
	path: string;
	change: string;
	rationale?: string;
	risk?: string;
}

interface StructuredPlan {
	summary: string;
	files: StructuredPlanFile[];
	not_modifying?: string[];
	assumptions?: string[];
	verification_focus?: string[];
}

const ProModeParams = Type.Object({
	task: Type.String({ description: "The task to run through Pro Mode orchestration." }),
	mode: Type.Optional(
		StringEnum(["research", "code"] as const, {
			description: 'Use "research" for answer generation or "code" for full multi-workspace coding/integration.',
			default: "research",
		}),
	),
	strategy: Type.Optional(
		StringEnum(["single", "fanout", "critique"] as const, {
			description: 'single = one solver, fanout = multiple workers + integrator, critique = workers + critics + integrator.',
			default: "critique",
		}),
	),
	workers: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_WORKERS, description: `Worker count (1-${MAX_WORKERS}).` }),
	),
	critics: Type.Optional(
		Type.Integer({ minimum: 0, maximum: MAX_CRITICS, description: `Critic count (0-${MAX_CRITICS}).` }),
	),
	model: Type.Optional(Type.String({ description: "Model to use. Defaults to Fireworks Kimi K2.5 Turbo." })),
	isolatedWorkspaces: Type.Optional(
		Type.Boolean({ description: "For code mode, run workers in copied workspaces. Default: false for code mode." }),
	),
	yolo: Type.Optional(
		Type.Boolean({ description: "Skip interactive approval prompts in code mode. Research mode ignores this flag." }),
	),
});

function blankUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shorten(value: string, max = 160): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-pro-mode-prompt-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeName}.md`);
	await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const concurrency = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = new Array(concurrency).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function createWorkspaceCopy(sourceCwd: string, label: string): Promise<{ rootDir: string; workspace: string }> {
	const rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-pro-mode-workspace-"));
	const workspace = path.join(rootDir, label.replace(/[^\w.-]+/g, "_"));
	await cp(sourceCwd, workspace, {
		recursive: true,
		filter: (src) => !COPY_SKIP_NAMES.has(path.basename(src)),
		preserveTimestamps: true,
	});
	return { rootDir, workspace };
}

function makePendingResult(spec: ChildRunSpec): RuntimeRunResult {
	return {
		id: spec.id,
		label: spec.label,
		stage: spec.stage,
		role: spec.role,
		cwd: spec.cwd,
		workspacePath: spec.workspacePath,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: blankUsage(),
		model: spec.model,
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		lastActivity: "queued…",
	};
}

function summarizeRuntimeResult(result: RuntimeRunResult): ResultSummary {
	return {
		id: result.id,
		label: result.label,
		stage: result.stage,
		role: result.role,
		cwd: result.cwd,
		workspacePath: result.workspacePath,
		exitCode: result.exitCode,
		preview: shorten(getFinalOutput(result.messages) || result.stderr || "(no output)", 220),
		usage: result.usage,
		model: result.model,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
	};
}

function formatToolCall(name: string, args: any): string {
	const pathValue = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
	switch (name) {
		case "read":
			return `read ${shorten(pathValue ?? "path", 36)}`;
		case "write":
			return `write ${shorten(pathValue ?? "path", 36)}`;
		case "edit":
			return `edit ${shorten(pathValue ?? "path", 36)}`;
		case "grep":
			return `grep ${shorten(String(args?.pattern ?? "pattern"), 24)}`;
		case "find":
			return `find ${shorten(String(args?.pattern ?? "*"), 24)}`;
		case "bash":
			return `$ ${shorten(String(args?.command ?? "command"), 40)}`;
		default:
			return `${name} ${shorten(JSON.stringify(args ?? {}), 40)}`;
	}
}

function getLatestActivity(result: RuntimeRunResult): string {
	if (result.lastActivity) return result.lastActivity;
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const message: any = result.messages[i];
		if (message.role === "toolResult") {
			const text = renderMessageContent(message);
			return `${message.toolName ?? "tool"}: ${shorten(text || "done", 52)}`;
		}
		if (message.role === "assistant") {
			const toolCall = [...(message.content ?? [])].reverse().find((part: any) => part?.type === "toolCall");
			if (toolCall) return formatToolCall(toolCall.name ?? "tool", toolCall.arguments ?? {});
			const text = renderMessageContent(message);
			if (text) return shorten(text, 52);
		}
	}
	return shorten(result.stderr || "(running)", 52);
}

function getResultBadge(result: RuntimeRunResult): string {
	const icon = result.exitCode === -1 ? "⏳" : result.exitCode === 0 ? "✓" : "✗";
	if (result.stage === "context") {
		const n = result.id.match(/context-(\d+)/)?.[1] ?? "?";
		return `B${n}${icon}`;
	}
	if (result.stage === "worker") {
		const n = result.id.match(/worker-(\d+)/)?.[1] ?? "?";
		return `W${n}${icon}`;
	}
	if (result.stage === "critic") {
		const n = result.id.match(/critic-(\d+)/)?.[1] ?? "?";
		return `C${n}${icon}`;
	}
	if (result.stage === "action") return `A${icon}`;
	if (result.stage === "verifier") return `V${icon}`;
	return `I${icon}`;
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
	return `$${cost.toFixed(4)}`;
}

function calculateTotalCost(results: RuntimeRunResult[] | ResultSummary[]): number {
	return results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
}

function getContextRunCount(params: ProRunParams, contextMessageCount = 0): number {
	if (contextMessageCount <= 0) return 0;
	if (params.mode === "research") {
		return params.strategy === "fanout" ? 2 : 0;
	}
	if (params.strategy === "fanout") return 2;
	return 1;
}

function getExpectedRunCount(params: ProRunParams, contextMessageCount = 0): number {
	const contextRuns = getContextRunCount(params, contextMessageCount);
	if (params.mode === "code") {
		const workers = params.strategy === "single" ? 1 : params.workerCount;
		const critics = params.strategy === "critique" ? params.criticCount : 0;
		return contextRuns + workers + critics + 3; // planner + action + verifier
	}
	return params.strategy === "single" ? 1 : contextRuns + params.workerCount + (params.strategy === "critique" ? params.criticCount : 0) + 1;
}

function makeProgressBar(done: number, total: number, width = 20): string {
	const filled = Math.round((done / total) * width);
	const empty = width - filled;
	return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${done}/${total}`;
}

function chunkStatusBadges(badges: string[], chunkSize = 8): string[] {
	const lines: string[] = [];
	for (let i = 0; i < badges.length; i += chunkSize) {
		lines.push(badges.slice(i, i + chunkSize).join("  "));
	}
	return lines;
}

function makeDashboardLines(params: ProRunParams, results: RuntimeRunResult[], contextMessageCount: number): string[] {
	const expectedTotal = getExpectedRunCount(params, contextMessageCount);
	const done = results.filter((r) => r.exitCode !== -1).length;
	const running = results.filter((r) => r.exitCode === -1).length;
	const totalCost = calculateTotalCost(results);
	const progressBar = makeProgressBar(done, expectedTotal);

	let modeDisplay: string;
	if (params.mode === "code") {
		const workerTotal = params.strategy === "single" ? 1 : params.workerCount;
		const criticTotal = params.strategy === "critique" ? params.criticCount : 0;
		const contextRuns = getContextRunCount(params, contextMessageCount);
		const label = params.strategy === "fanout" ? "ProCodeFast" : params.strategy === "single" ? "ProCode [Single]" : "ProCode [Full]";
		modeDisplay = `${label} ${contextRuns}+${workerTotal}+${criticTotal}+1+1+1 = ${expectedTotal} runs`;
	} else if (params.strategy === "single") {
		modeDisplay = "Pro [Single] 1 run";
	} else if (params.strategy === "fanout") {
		modeDisplay = `ProFast [2+${params.workerCount}+1] ${expectedTotal} runs`;
	} else {
		modeDisplay = `Pro [Full] ${params.workerCount}+${params.criticCount}+1 = ${expectedTotal} runs`;
	}

	const header = `${modeDisplay} ${progressBar}`;
	const costLine = `💰 Total: ${formatCost(totalCost)} ${running > 0 ? "⏳" : "✓"}`;
	const model = shorten(params.model, 48);
	const contextLine = `🧠 Session context available: ${contextMessageCount} messages`;
	const lines = [header, costLine, model, contextLine];

	const ordered: RuntimeRunResult[] = [];
	const pushPlaceholder = (id: string, label: string, stage: RunStage, role: string) => {
		ordered.push(
			results.find((r) => r.id === id || (id === "integrator-1" && r.stage === "integrator")) ?? {
				id,
				label,
				stage,
				role,
				cwd: "",
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: blankUsage(),
				startedAt: 0,
			},
		);
	};

	for (let i = 1; i <= getContextRunCount(params, contextMessageCount); i++) {
		pushPlaceholder(`context-${i}`, `Context Brief ${i}`, "context", "context");
	}

	if (params.mode === "code") {
		const workerTotal = params.strategy === "single" ? 1 : params.workerCount;
		for (let i = 1; i <= workerTotal; i++) pushPlaceholder(`worker-${i}`, `Worker ${i}`, "worker", "worker");
		if (params.strategy === "critique") {
			for (let i = 1; i <= params.criticCount; i++) pushPlaceholder(`critic-${i}`, `Critic ${i}`, "critic", "critic");
		}
		pushPlaceholder("integrator-1", "Planner", "integrator", "planner");
		pushPlaceholder("action-1", "Action Agent", "action", "action");
		pushPlaceholder("verifier-1", "Verifier", "verifier", "verifier");
	} else if (params.strategy === "single") {
		pushPlaceholder("integrator-1", "Final Solver", "integrator", "integrator");
	} else {
		for (let i = 1; i <= params.workerCount; i++) pushPlaceholder(`worker-${i}`, `Worker ${i}`, "worker", "worker");
		if (params.strategy === "critique") {
			for (let i = 1; i <= params.criticCount; i++) pushPlaceholder(`critic-${i}`, `Critic ${i}`, "critic", "critic");
		}
		pushPlaceholder("integrator-1", "Integrator", "integrator", "integrator");
	}

	lines.push(...chunkStatusBadges(ordered.map(getResultBadge)));

	const latestResults = [...results]
		.sort((a, b) => (b.lastActivityAt ?? b.endedAt ?? b.startedAt) - (a.lastActivityAt ?? a.endedAt ?? a.startedAt))
		.slice(0, 6);
	for (const result of latestResults) {
		const icon = result.exitCode === -1 ? "⏳" : result.exitCode === 0 ? "✓" : "✗";
		const stage = result.stage.padEnd(10, " ");
		const preview = getLatestActivity(result);
		const cost = result.usage?.cost ? ` · ${formatCost(result.usage.cost)}` : "";
		lines.push(`${icon} ${stage} ${result.label}${cost}: ${preview}`);
	}

	if (running > 0) lines.push(`Running: ${running}`);
	return lines;
}

function renderMessageContent(message: any): string {
	const parts = Array.isArray(message?.content) ? message.content : [];
	const rendered = parts
		.map((part: any) => {
			if (!part || typeof part !== "object") return "";
			if (part.type === "text") return part.text ?? "";
			if (part.type === "image") return "[image]";
			if (part.type === "thinking") return "[thinking omitted]";
			if (part.type === "toolCall") {
				const args = part.arguments ? shorten(JSON.stringify(part.arguments), 300) : "";
				return `[tool call: ${part.name ?? "unknown"}${args ? ` ${args}` : ""}]`;
			}
			return part.text ?? "";
		})
		.filter(Boolean);
	return rendered.join("\n").trim();
}

function labelForSessionEntry(entry: any, index: number): { raw: string; isConversationTurn: boolean; isUser: boolean; body: string } | null {
	if (!entry || typeof entry !== "object") return null;

	if (entry.type === "message" && entry.message) {
		const message = entry.message;
		const body = renderMessageContent(message) || "(no text content)";
		const role = message.role ?? "unknown";
		const label =
			role === "user"
				? "USER"
				: role === "assistant"
					? "ASSISTANT"
					: role === "toolResult"
						? `TOOL_OUTPUT:${message.toolName ?? "unknown"}`
						: role.toUpperCase();
		return {
			raw: `<segment index="${index}" label="[${label}]">\n${body}\n</segment>`,
			isConversationTurn: role === "user" || role === "assistant",
			isUser: role === "user",
			body,
		};
	}

	if (entry.type === "custom_message") {
		const customType = entry.customType ?? "custom";
		const body = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? "", null, 2);
		return {
			raw: `<segment index="${index}" label="[CUSTOM:${customType}]">\n${body}\n</segment>`,
			isConversationTurn: true,
			isUser: false,
			body,
		};
	}

	return null;
}

function extractSessionContext(ctx: ExtensionContext): SessionContextData {
	const entries = ctx.sessionManager.getBranch() as any[];
	const blocks: string[] = [];
	const recentTurns: string[] = [];
	let latestUserMessage = "(no recent user message)";
	let messageCount = 0;

	for (const [index, entry] of entries.entries()) {
		const labeled = labelForSessionEntry(entry, index + 1);
		if (!labeled) continue;
		messageCount += 1;
		blocks.push(labeled.raw);
		if (labeled.isConversationTurn) {
			recentTurns.push(labeled.raw);
			if (recentTurns.length > 2) recentTurns.shift();
		}
		if (labeled.isUser) latestUserMessage = labeled.body;
	}

	return {
		fullThread: blocks.length > 0 ? blocks.join("\n\n") : "(no previous chat context)",
		recentTurns: recentTurns.length > 0 ? recentTurns.join("\n\n") : "(no recent conversation turns)",
		latestUserMessage,
		messageCount,
	};
}

function countConversationMessages(ctx: ExtensionContext): number {
	return extractSessionContext(ctx).messageCount;
}

function buildFullContextWorkerTask(task: string, fullThread: string): string {
	return [
		"Full current chat context from the parent Pi session:",
		fullThread,
		"Original task:",
		task,
		"Be concrete, tool-backed when helpful, and self-critical.",
	].join("\n\n");
}

function formatDurableConstraints(constraints: DurableConstraint[]): string {
	if (constraints.length === 0) return "(no durable constraints extracted)";
	return constraints
		.map((item) => {
			const superseded = item.superseded_by ? ` [superseded_by=${item.superseded_by}]` : "";
			return `- ${item.constraint} (${item.source}${superseded})`;
		})
		.join("\n");
}

function serializeContextBrief(brief: ContextBrief): string {
	return JSON.stringify(brief, null, 2);
}

function buildCompactedWorkerTask(task: string, session: SessionContextData, brief: ContextBrief): string {
	return [
		"Current raw user request:",
		session.latestUserMessage,
		"Most recent raw conversation turns:",
		session.recentTurns,
		"Durable constraints (must respect):",
		formatDurableConstraints(brief.durable_constraints ?? []),
		"Compacted working notes (helper, not ground truth):",
		serializeContextBrief(brief),
		"Original task:",
		task,
		"If the compacted brief seems incomplete or inconsistent with the raw latest turns, trust the raw latest turns and say so.",
	].join("\n\n");
}

function buildCriticTask(task: string, fullThread: string, workerResults: RuntimeRunResult[]): string {
	const workerBlocks = workerResults
		.map((result) => {
			const location = result.workspacePath ?? result.cwd;
			return [
				`<worker id=\"${result.id}\" role=\"${result.role}\">`,
				`Label: ${result.label}`,
				`Workspace: ${location}`,
				`Exit code: ${result.exitCode}`,
				"Output:",
				getFinalOutput(result.messages) || result.stderr || "(no output)",
				"</worker>",
			].join("\n");
		})
		.join("\n\n");

	return [
		"Full current chat context from the parent Pi session:",
		fullThread,
		"Original task:",
		task,
		"Worker outputs:",
		workerBlocks,
		"Review the workers. Rank the strongest approaches, identify weak reasoning, and give concrete integration advice.",
	].join("\n\n");
}

function buildIntegratorTask(task: string, contextBlock: string, workerResults: RuntimeRunResult[], criticResults: RuntimeRunResult[], options?: { codePlan?: boolean }): string {
	const workerBlocks = workerResults
		.map((result) => {
			const location = result.workspacePath ?? result.cwd;
			return [
				`<worker id=\"${result.id}\" role=\"${result.role}\">`,
				`Label: ${result.label}`,
				`Workspace: ${location}`,
				`Exit code: ${result.exitCode}`,
				"Output:",
				getFinalOutput(result.messages) || result.stderr || "(no output)",
				"</worker>",
			].join("\n");
		})
		.join("\n\n");

	const criticBlocks = criticResults.length
		? criticResults
				.map((result) => {
					return [
						`<critic id=\"${result.id}\" role=\"${result.role}\">`,
						getFinalOutput(result.messages) || result.stderr || "(no output)",
						"</critic>",
					].join("\n");
				})
				.join("\n\n")
		: "(no critic reports)";

	return [
		contextBlock,
		"Original task:",
		task,
		"Worker outputs:",
		workerBlocks,
		"Critic reports:",
		criticBlocks,
		options?.codePlan
			? "For code mode: produce the best implementation plan only and RETURN STRICT JSON ONLY matching the required schema. No markdown. No prose outside JSON. Do not modify files."
			: "For research mode: produce the best final answer.",
	].join("\n\n");
}

function serializeStructuredPlan(plan: StructuredPlan): string {
	return JSON.stringify(plan, null, 2);
}

function buildActionExecutionTask(
	task: string,
	durableConstraints: DurableConstraint[],
	approvedPlan: StructuredPlan,
	workerResults: RuntimeRunResult[],
	criticResults: RuntimeRunResult[],
): string {
	const workerBlocks = workerResults
		.map((result) => `- ${result.label} [${result.role}]: ${shorten(getFinalOutput(result.messages) || result.stderr || "(no output)", 600)}`)
		.join("\n");
	const criticBlocks = criticResults.length
		? criticResults
				.map((result) => `- ${result.label} [${result.role}]: ${shorten(getFinalOutput(result.messages) || result.stderr || "(no output)", 600)}`)
				.join("\n")
		: "(no critic reports)";

	return [
		"Original task:",
		task,
		"Durable constraints:",
		formatDurableConstraints(durableConstraints),
		"Approved structured plan JSON:",
		serializeStructuredPlan(approvedPlan),
		"Worker hypotheses (treat as hypotheses, not facts):",
		workerBlocks || "(no worker output)",
		"Critic guidance (treat as hypotheses, not facts):",
		criticBlocks,
		"Re-read the real workspace yourself, then apply the smallest correct change that satisfies the approved plan.",
	].join("\n\n");
}

function buildVerifierTask(task: string, approvedPlan: StructuredPlan, changedFiles: string[], actualDiff: string): string {
	return [
		"Original task:",
		task,
		"Approved structured plan JSON:",
		serializeStructuredPlan(approvedPlan),
		"Actual changed files:",
		changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "(no changed files detected)",
		"Actual git diff (ground truth):",
		actualDiff,
		"Verify the actual workspace state. Run checks yourself when possible and report PASS / FAIL / INCONCLUSIVE.",
	].join("\n\n");
}

function extractJsonCandidate(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		return trimmed;
	}

	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();

	let start = -1;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (char === "\\") {
			escape = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			if (start === -1) start = i;
			depth += 1;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0 && start !== -1) return trimmed.slice(start, i + 1);
		}
	}
	return null;
}

function parseJsonObject<T>(text: string): T | null {
	const candidate = extractJsonCandidate(text);
	if (!candidate) return null;
	try {
		return JSON.parse(candidate) as T;
	} catch {
		return null;
	}
}

function normalizePlan(raw: StructuredPlan | null, fallbackText: string): StructuredPlan {
	if (raw && typeof raw.summary === "string" && Array.isArray(raw.files)) {
		return {
			summary: raw.summary,
			files: raw.files
				.filter((file) => typeof file?.path === "string" && file.path.trim().length > 0)
				.map((file) => ({
					path: file.path.trim(),
					change: typeof file.change === "string" ? file.change : "planned change",
					rationale: typeof file.rationale === "string" ? file.rationale : undefined,
					risk: typeof file.risk === "string" ? file.risk : undefined,
				})),
			not_modifying: Array.isArray(raw.not_modifying) ? raw.not_modifying.filter((item) => typeof item === "string") : [],
			assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.filter((item) => typeof item === "string") : [],
			verification_focus: Array.isArray(raw.verification_focus) ? raw.verification_focus.filter((item) => typeof item === "string") : [],
		};
	}

	return {
		summary: shorten(fallbackText || "No structured plan produced", 200),
		files: [],
		not_modifying: [],
		assumptions: ["Planner did not return strict JSON; fallback plan inferred from raw output."],
		verification_focus: [],
	};
}

function normalizeContextBrief(raw: ContextBrief | null, task: string, variant: string): ContextBrief {
	if (raw) {
		return {
			task_focus: raw.task_focus ?? { current_request: shorten(task, 160), scope: "" },
			durable_constraints: Array.isArray(raw.durable_constraints) ? raw.durable_constraints : [],
			decisions_made: Array.isArray(raw.decisions_made) ? raw.decisions_made : [],
			decisions_rejected: Array.isArray(raw.decisions_rejected) ? raw.decisions_rejected : [],
			known_state: Array.isArray(raw.known_state) ? raw.known_state : [],
			artifacts: raw.artifacts ?? { files_mentioned: [], commands_mentioned: [], external_refs: [] },
			open_questions: Array.isArray(raw.open_questions) ? raw.open_questions : [],
			meta: { variant, omitted_on_purpose: raw.meta?.omitted_on_purpose ?? [] },
		};
	}

	return {
		task_focus: { current_request: shorten(task, 160), scope: "Fallback brief because compactor did not return strict JSON." },
		durable_constraints: [],
		decisions_made: [],
		decisions_rejected: [],
		known_state: ["Compactor fallback engaged; downstream agents should rely more heavily on raw recent turns."],
		artifacts: { files_mentioned: [], commands_mentioned: [], external_refs: [] },
		open_questions: [],
		meta: { variant, omitted_on_purpose: [] },
	};
}

function mergeDurableConstraints(briefs: ContextBrief[]): DurableConstraint[] {
	const seen = new Set<string>();
	const merged: DurableConstraint[] = [];
	for (const brief of briefs) {
		for (const item of brief.durable_constraints ?? []) {
			if (!item?.constraint) continue;
			const key = `${item.constraint}@@${item.source ?? "unknown"}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push({
				source: item.source ?? "unknown",
				constraint: item.constraint,
				superseded_by: item.superseded_by ?? null,
			});
		}
	}
	return merged;
}

function buildCompactorTask(task: string, fullThread: string, variant: "constraints" | "questions"): string {
	return [
		"Latest user task:",
		task,
		"Full visible parent session thread:",
		fullThread,
		`Compaction variant: ${variant}`,
		"Return strict JSON only. Do not greet. Do not answer the task. Do not add prose outside the JSON object.",
	].join("\n\n");
}

async function runShellCommand(command: string, cwd: string, signal: AbortSignal | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-lc", command], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on("error", () => resolve({ code: 1, stdout, stderr: stderr || "failed to spawn command" }));
		if (signal) {
			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 2000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

function parseGitStatusPaths(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const rawPath = line.slice(3).trim();
			const renamed = rawPath.split(" -> ").at(-1) ?? rawPath;
			return renamed.replace(/^"|"$/g, "");
		});
}

async function captureWorkspaceDiff(cwd: string, signal: AbortSignal | undefined): Promise<{ changedFiles: string[]; diffText: string }> {
	const insideGit = await runShellCommand("git rev-parse --is-inside-work-tree", cwd, signal);
	if (insideGit.code !== 0 || !insideGit.stdout.includes("true")) {
		return { changedFiles: [], diffText: "(git diff unavailable: workspace is not inside a git repository)" };
	}

	const [statusResult, diffResult, cachedDiffResult] = await Promise.all([
		runShellCommand("git -c core.quotepath=false status --porcelain=v1 --untracked-files=all", cwd, signal),
		runShellCommand("git --no-pager diff --no-ext-diff -- .", cwd, signal),
		runShellCommand("git --no-pager diff --no-ext-diff --cached -- .", cwd, signal),
	]);

	const changedFiles = statusResult.code === 0 ? parseGitStatusPaths(statusResult.stdout) : [];
	const diffParts = [diffResult.stdout.trim(), cachedDiffResult.stdout.trim()].filter(Boolean);
	const diffText = diffParts.length > 0 ? diffParts.join("\n\n") : "(no git diff output)";
	return { changedFiles, diffText };
}

async function runChild(spec: ChildRunSpec, signal: AbortSignal | undefined, onUpdate?: (result: RuntimeRunResult) => void): Promise<RuntimeRunResult> {
	const runtimeResult: RuntimeRunResult = {
		id: spec.id,
		label: spec.label,
		stage: spec.stage,
		role: spec.role,
		cwd: spec.cwd,
		workspacePath: spec.workspacePath,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: blankUsage(),
		model: spec.model,
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		lastActivity: "starting…",
	};

	const args = ["--mode", "json", "-p", "--no-session", "--model", spec.model, "--tools", spec.tools.join(",")];
	let promptDir: string | null = null;
	let promptFilePath: string | null = null;

	try {
		const tempPrompt = await writePromptToTempFile(spec.id, spec.systemPrompt);
		promptDir = tempPrompt.dir;
		promptFilePath = tempPrompt.filePath;
		args.push("--append-system-prompt", promptFilePath);
		args.push(`Task: ${spec.task}`);

		const invocation = getPiInvocation(args);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: spec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_PRO_MODE_CHILD: "1",
					PI_PRO_MODE_STAGE: spec.stage,
					PI_PRO_MODE_ROLE: spec.role,
				},
			});

			let stdoutBuffer = "";

			const emit = () => {
				onUpdate?.(runtimeResult);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					runtimeResult.messages.push(message);
					runtimeResult.lastActivityAt = Date.now();
					if ((message as any).role === "assistant") {
						const toolCall = [...(((message as any).content ?? []) as any[])].reverse().find((part: any) => part?.type === "toolCall");
						runtimeResult.lastActivity = toolCall
							? formatToolCall(toolCall.name ?? "tool", toolCall.arguments ?? {})
							: shorten(renderMessageContent(message), 64) || runtimeResult.lastActivity;
						runtimeResult.usage.turns += 1;
						if (message.usage) {
							runtimeResult.usage.input += message.usage.input || 0;
							runtimeResult.usage.output += message.usage.output || 0;
							runtimeResult.usage.cacheRead += message.usage.cacheRead || 0;
							runtimeResult.usage.cacheWrite += message.usage.cacheWrite || 0;
							runtimeResult.usage.cost += message.usage.cost?.total || 0;
							runtimeResult.usage.contextTokens = message.usage.totalTokens || runtimeResult.usage.contextTokens;
						}
						runtimeResult.stopReason = message.stopReason || runtimeResult.stopReason;
						runtimeResult.errorMessage = message.errorMessage || runtimeResult.errorMessage;
						runtimeResult.model = message.model || runtimeResult.model;
					}
					emit();
				}

				if (event.type === "tool_result_end" && event.message) {
					const toolMessage = event.message as any;
					runtimeResult.messages.push(toolMessage as Message);
					runtimeResult.lastActivityAt = Date.now();
					runtimeResult.lastActivity = `${toolMessage.toolName ?? "tool"}: ${shorten(renderMessageContent(toolMessage) || "done", 64)}`;
					emit();
				}
			};

			proc.stdout.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				runtimeResult.stderr += data.toString();
				runtimeResult.lastActivityAt = Date.now();
				runtimeResult.lastActivity = shorten(data.toString().trim() || runtimeResult.stderr, 64);
				emit();
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 3000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		runtimeResult.exitCode = exitCode;
		runtimeResult.endedAt = Date.now();
		if (wasAborted) {
			runtimeResult.exitCode = 1;
			runtimeResult.errorMessage = runtimeResult.errorMessage || "aborted";
		}
		return runtimeResult;
	} finally {
		if (promptFilePath) {
			try {
				await rm(promptFilePath, { force: true });
			} catch {
				// ignore cleanup error
			}
		}
		if (promptDir) {
			try {
				await rm(promptDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup error
			}
		}
	}
}

function buildReport(
	params: ProRunParams,
	results: RuntimeRunResult[],
	finalText: string,
	startedAt: number,
	endedAt: number,
	contextMessageCount: number,
): ProRunReport {
	return {
		mode: params.mode,
		strategy: params.strategy,
		model: params.model,
		task: params.task,
		workerCount: params.workerCount,
		criticCount: params.criticCount,
		isolatedWorkspaces: params.isolatedWorkspaces,
		results: results.map(summarizeRuntimeResult),
		finalText,
		startedAt,
		endedAt,
		totalCost: calculateTotalCost(results),
		expectedRuns: getExpectedRunCount(params, contextMessageCount),
		contextMessageCount,
	};
}

async function withDashboard<T>(
	ctx: ExtensionContext,
	params: ProRunParams,
	contextMessageCount: number,
	run: (update: (results: RuntimeRunResult[]) => void) => Promise<T>,
): Promise<T> {
	const update = (results: RuntimeRunResult[]) => {
		if (!ctx.hasUI) return;
		const lines = makeDashboardLines(params, results, contextMessageCount);
		ctx.ui.setWidget("pro-mode", lines);
		ctx.ui.setStatus("pro-mode", `${lines[0]} · ${formatCost(calculateTotalCost(results))}`);
	};

	try {
		return await run(update);
	} finally {
		if (ctx.hasUI) {
			ctx.ui.setWidget("pro-mode", undefined);
			ctx.ui.setStatus("pro-mode", undefined);
		}
	}
}

async function runPipeline(ctx: ExtensionContext, params: ProRunParams, targetCwd = ctx.cwd): Promise<ProRunReport> {
	const allResults: RuntimeRunResult[] = [];
	const startedAt = Date.now();
	const workerWorkspaceRoots: string[] = [];
	const sessionContext = extractSessionContext(ctx);
	const conversationMessageCount = sessionContext.messageCount;

	const upsertResult = (result: RuntimeRunResult) => {
		const index = allResults.findIndex((item) => item.id === result.id);
		if (index === -1) allResults.push(result);
		else allResults[index] = result;
	};

	return withDashboard(ctx, params, conversationMessageCount, async (updateDashboard) => {
		const emit = () => updateDashboard([...allResults]);

		try {
			const shouldRunCompaction = conversationMessageCount > 0;
			const compactorVariants: Array<"constraints" | "questions"> =
				!shouldRunCompaction
					? []
					: params.mode === "research" && params.strategy === "fanout"
						? ["constraints", "questions"]
						: params.mode === "code" && params.strategy === "fanout"
							? ["constraints", "questions"]
							: params.mode === "code"
								? ["constraints"]
								: [];
			const contextBriefs: ContextBrief[] = [];

			if (compactorVariants.length > 0) {
				const contextSpecs = compactorVariants.map((variant, index) => ({
					id: `context-${index + 1}`,
					label: `Context Brief ${index + 1}`,
					stage: "context" as const,
					role: variant === "constraints" ? "Constraints Compactor" : "Questions Compactor",
					cwd: targetCwd,
					model: params.model,
					tools: READ_ONLY_TOOLS,
					systemPrompt: buildContextCompactorSystemPrompt({ variant }),
					task: buildCompactorTask(params.task, sessionContext.fullThread, variant),
				}));

				contextSpecs.forEach((spec) => upsertResult(makePendingResult(spec)));
				emit();
				await mapWithConcurrencyLimit(contextSpecs, Math.min(contextSpecs.length, MAX_CONCURRENCY), async (spec, index) => {
					const result = await runChild(spec, ctx.signal, (partial) => {
						upsertResult(partial);
						emit();
					});
					upsertResult(result);
					emit();
					const parsed = parseJsonObject<ContextBrief>(getFinalOutput(result.messages) || result.stderr || "");
					contextBriefs[index] = normalizeContextBrief(parsed, params.task, compactorVariants[index]);
					return result;
				});
			}

			const durableConstraints = mergeDurableConstraints(contextBriefs);
			const compactedIntegratorContext = [
				"Current raw user request:",
				sessionContext.latestUserMessage,
				"Most recent raw conversation turns:",
				sessionContext.recentTurns,
				"Durable constraints (must respect):",
				formatDurableConstraints(durableConstraints),
				"Compacted working notes:",
				contextBriefs.length > 0 ? contextBriefs.map((brief, index) => `<brief index=\"${index + 1}\">\n${serializeContextBrief(brief)}\n</brief>`).join("\n\n") : "(no compacted brief)",
			].join("\n\n");
			const fullContextBlock = ["Full current chat context from the parent Pi session:", sessionContext.fullThread].join("\n\n");

			if (params.mode !== "code") {
				const researchWorkerCount = params.strategy === "single" ? 1 : params.workerCount;
				const researchWorkerSpecs = await Promise.all(
					new Array(researchWorkerCount).fill(null).map(async (_value, index) => {
						const role = WORKER_ROLES[index % WORKER_ROLES.length];
						const brief = contextBriefs[index % Math.max(1, contextBriefs.length)] ?? normalizeContextBrief(null, params.task, "constraints");
						return {
							id: `worker-${index + 1}`,
							label: params.strategy === "single" ? "Final Solver" : `Worker ${index + 1}`,
							stage: params.strategy === "single" ? ("integrator" as const) : ("worker" as const),
							role: params.strategy === "single" ? "Single Solver" : role.name,
							cwd: targetCwd,
							model: params.model,
							tools: READ_ONLY_TOOLS,
							systemPrompt:
								params.strategy === "single"
									? buildIntegratorSystemPrompt({
										mode: params.mode,
										strategy: params.strategy,
										originalCwd: targetCwd,
										workerCount: 1,
										criticCount: 0,
									})
									: buildWorkerSystemPrompt({
										mode: params.mode,
										workerIndex: index + 1,
										totalWorkers: researchWorkerCount,
										role,
										originalCwd: targetCwd,
										workspacePath: targetCwd,
									}),
							task:
								params.strategy === "fanout"
									? buildCompactedWorkerTask(params.task, sessionContext, brief)
									: buildFullContextWorkerTask(params.task, sessionContext.fullThread),
						};
					}),
				);

				researchWorkerSpecs.forEach((spec) => upsertResult(makePendingResult(spec)));
				emit();
				await mapWithConcurrencyLimit(researchWorkerSpecs, Math.min(researchWorkerCount, MAX_CONCURRENCY), async (spec) => {
					const result = await runChild(spec, ctx.signal, (partial) => {
						upsertResult(partial);
						emit();
					});
					upsertResult(result);
					emit();
					return result;
				});

				if (params.strategy === "single") {
					const result = allResults.find((item) => item.stage === "integrator")!;
					return buildReport(
						params,
						allResults,
						getFinalOutput(result.messages) || result.stderr || "(no output)",
						startedAt,
						Date.now(),
						conversationMessageCount,
					);
				}

				const workerResults = allResults.filter((result) => result.stage === "worker");
				const criticResults: RuntimeRunResult[] = [];

				if (params.strategy === "critique" && params.criticCount > 0) {
					const criticSpecs = new Array(params.criticCount).fill(null).map((_value, index) => {
						const role = CRITIC_ROLES[index % CRITIC_ROLES.length];
						return {
							id: `critic-${index + 1}`,
							label: `Critic ${index + 1}`,
							stage: "critic" as const,
							role: role.name,
							cwd: targetCwd,
							model: params.model,
							tools: READ_ONLY_TOOLS,
							systemPrompt: buildCriticSystemPrompt({
								mode: params.mode,
								criticIndex: index + 1,
								totalCritics: params.criticCount,
								role,
								originalCwd: targetCwd,
							}),
							task: buildCriticTask(params.task, sessionContext.fullThread, workerResults),
						};
					});

					criticSpecs.forEach((spec) => upsertResult(makePendingResult(spec)));
					emit();
					await mapWithConcurrencyLimit(criticSpecs, Math.min(params.criticCount, MAX_CONCURRENCY), async (spec) => {
						const result = await runChild(spec, ctx.signal, (partial) => {
							upsertResult(partial);
							emit();
						});
						upsertResult(result);
						criticResults.push(result);
						emit();
						return result;
					});
				}

				const integratorContext = params.strategy === "fanout" ? compactedIntegratorContext : fullContextBlock;
				upsertResult(makePendingResult({
					id: "integrator-1",
					label: "Integrator",
					stage: "integrator",
					role: "Final Synthesizer",
					cwd: targetCwd,
					model: params.model,
					tools: READ_ONLY_TOOLS,
					systemPrompt: "",
					task: "",
				}));
				emit();
				const integratorResult = await runChild(
					{
						id: "integrator-1",
						label: "Integrator",
						stage: "integrator",
						role: "Final Synthesizer",
						cwd: targetCwd,
						model: params.model,
						tools: READ_ONLY_TOOLS,
						systemPrompt: buildIntegratorSystemPrompt({
							mode: params.mode,
							strategy: params.strategy,
							originalCwd: targetCwd,
							workerCount: researchWorkerCount,
							criticCount: params.strategy === "critique" ? params.criticCount : 0,
						}),
						task: buildIntegratorTask(params.task, integratorContext, workerResults, criticResults),
					},
					ctx.signal,
					(partial) => {
						upsertResult(partial);
						emit();
					},
				);
				upsertResult(integratorResult);
				emit();

				return buildReport(
					params,
					allResults,
					getFinalOutput(integratorResult.messages) || integratorResult.stderr || "(no output)",
					startedAt,
					Date.now(),
					conversationMessageCount,
				);
			}

			const codeWorkerCount = params.strategy === "single" ? 1 : params.workerCount;
			const workerSpecs = await Promise.all(
				new Array(codeWorkerCount).fill(null).map(async (_value, index) => {
					let cwd = targetCwd;
					let workspacePath: string | undefined;
					if (params.isolatedWorkspaces) {
						const workspace = await createWorkspaceCopy(targetCwd, `worker-${index + 1}`);
						workerWorkspaceRoots.push(workspace.rootDir);
						cwd = workspace.workspace;
						workspacePath = workspace.workspace;
					}
					const role = WORKER_ROLES[index % WORKER_ROLES.length];
					const brief = contextBriefs[index % Math.max(1, contextBriefs.length)] ?? normalizeContextBrief(null, params.task, "constraints");
					return {
						id: `worker-${index + 1}`,
						label: `Worker ${index + 1}`,
						stage: "worker" as const,
						role: role.name,
						cwd,
						workspacePath,
						model: params.model,
						tools: READ_ONLY_TOOLS,
						systemPrompt: buildWorkerSystemPrompt({
							mode: params.mode,
							workerIndex: index + 1,
							totalWorkers: codeWorkerCount,
							role,
							originalCwd: targetCwd,
							workspacePath: workspacePath ?? targetCwd,
						}),
						task:
							params.strategy === "fanout"
								? buildCompactedWorkerTask(params.task, sessionContext, brief)
								: buildFullContextWorkerTask(params.task, sessionContext.fullThread),
					};
				}),
			);

			workerSpecs.forEach((spec) => upsertResult(makePendingResult(spec)));
			emit();
			await mapWithConcurrencyLimit(workerSpecs, Math.min(codeWorkerCount, MAX_CONCURRENCY), async (spec) => {
				const result = await runChild(spec, ctx.signal, (partial) => {
					upsertResult(partial);
					emit();
				});
				upsertResult(result);
				emit();
				return result;
			});

			const workerResults = allResults.filter((result) => result.stage === "worker");
			const criticResults: RuntimeRunResult[] = [];

			if (params.strategy === "critique" && params.criticCount > 0) {
				const criticSpecs = new Array(params.criticCount).fill(null).map((_value, index) => {
					const role = CRITIC_ROLES[index % CRITIC_ROLES.length];
					return {
						id: `critic-${index + 1}`,
						label: `Critic ${index + 1}`,
						stage: "critic" as const,
						role: role.name,
						cwd: targetCwd,
						model: params.model,
						tools: READ_ONLY_TOOLS,
						systemPrompt: buildCriticSystemPrompt({
							mode: params.mode,
							criticIndex: index + 1,
							totalCritics: params.criticCount,
							role,
							originalCwd: targetCwd,
						}),
						task: buildCriticTask(params.task, sessionContext.fullThread, workerResults),
					};
				});

				criticSpecs.forEach((spec) => upsertResult(makePendingResult(spec)));
				emit();
				await mapWithConcurrencyLimit(criticSpecs, Math.min(params.criticCount, MAX_CONCURRENCY), async (spec) => {
					const result = await runChild(spec, ctx.signal, (partial) => {
						upsertResult(partial);
						emit();
					});
					upsertResult(result);
					criticResults.push(result);
					emit();
					return result;
				});
			}

			const plannerContext = params.strategy === "fanout" ? compactedIntegratorContext : fullContextBlock;
			upsertResult(makePendingResult({
				id: "integrator-1",
				label: "Planner",
				stage: "integrator",
				role: "Plan Synthesizer",
				cwd: targetCwd,
				model: params.model,
				tools: READ_ONLY_TOOLS,
				systemPrompt: "",
				task: "",
			}));
			emit();
			const plannerResult = await runChild(
				{
					id: "integrator-1",
					label: "Planner",
					stage: "integrator",
					role: "Plan Synthesizer",
					cwd: targetCwd,
					model: params.model,
					tools: READ_ONLY_TOOLS,
					systemPrompt: buildIntegratorSystemPrompt({
						mode: params.mode,
						strategy: params.strategy,
						originalCwd: targetCwd,
						workerCount: codeWorkerCount,
						criticCount: params.strategy === "critique" ? params.criticCount : 0,
					}),
					task: buildIntegratorTask(params.task, plannerContext, workerResults, criticResults, { codePlan: true }),
				},
				ctx.signal,
				(partial) => {
					upsertResult(partial);
					emit();
				},
			);
			upsertResult(plannerResult);
			emit();

			const approvedPlanRaw = getFinalOutput(plannerResult.messages) || plannerResult.stderr || "(no plan produced)";
			const approvedPlan = normalizePlan(parseJsonObject<StructuredPlan>(approvedPlanRaw), approvedPlanRaw);
			if (ctx.hasUI && !params.yolo) {
				const ok = await ctx.ui.confirm(
					"Approve action plan?",
					[
						`Task: ${shorten(params.task, 140)}`,
						`Model: ${params.model}`,
						"The action agent will be the only writer.",
						`Plan summary: ${approvedPlan.summary}`,
						approvedPlan.files.length > 0 ? `Files to touch:\n${approvedPlan.files.map((file) => `- ${file.path}: ${file.change}`).join("\n")}` : "Files to touch: (planner did not declare files)",
					].join("\n\n"),
				);
				if (!ok) {
					return buildReport(
						params,
						allResults,
						`Canceled before mutation.\n\n## Proposed Structured Plan\n\n${serializeStructuredPlan(approvedPlan)}`,
						startedAt,
						Date.now(),
						conversationMessageCount,
					);
				}
			} else if (params.yolo && ctx.hasUI) {
				ctx.ui.notify("YOLO enabled: skipping plan approval prompt.", "warning");
			}

			upsertResult(makePendingResult({
				id: "action-1",
				label: "Action Agent",
				stage: "action",
				role: "Final Action Agent",
				cwd: targetCwd,
				model: params.model,
				tools: FULL_TOOLS,
				systemPrompt: "",
				task: "",
			}));
			emit();
			const actionResult = await runChild(
				{
					id: "action-1",
					label: "Action Agent",
					stage: "action",
					role: "Final Action Agent",
					cwd: targetCwd,
					model: params.model,
					tools: FULL_TOOLS,
					systemPrompt: buildActionAgentSystemPrompt({ originalCwd: targetCwd, mode: params.mode }),
					task: buildActionExecutionTask(params.task, durableConstraints, approvedPlan, workerResults, criticResults),
				},
				ctx.signal,
				(partial) => {
					upsertResult(partial);
					emit();
				},
			);
			upsertResult(actionResult);
			emit();

			const { changedFiles, diffText } = await captureWorkspaceDiff(targetCwd, ctx.signal);
			const plannedFiles = new Set(approvedPlan.files.map((file) => file.path));
			const undeclaredFiles = changedFiles.filter((file) => !plannedFiles.has(file));

			upsertResult(makePendingResult({
				id: "verifier-1",
				label: "Verifier",
				stage: "verifier",
				role: "Final Verifier",
				cwd: targetCwd,
				model: params.model,
				tools: READ_ONLY_TOOLS,
				systemPrompt: "",
				task: "",
			}));
			emit();
			const verifierResult = await runChild(
				{
					id: "verifier-1",
					label: "Verifier",
					stage: "verifier",
					role: "Final Verifier",
					cwd: targetCwd,
					model: params.model,
					tools: READ_ONLY_TOOLS,
					systemPrompt: buildVerifierSystemPrompt({ originalCwd: targetCwd, mode: params.mode }),
					task: buildVerifierTask(params.task, approvedPlan, changedFiles, diffText),
				},
				ctx.signal,
				(partial) => {
					upsertResult(partial);
					emit();
				},
			);
			upsertResult(verifierResult);
			emit();

			const finalText = [
				"## Approved Structured Plan",
				serializeStructuredPlan(approvedPlan),
				"## Changed Files",
				changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "(no changed files detected)",
				undeclaredFiles.length > 0 ? `## Plan Divergence\n- ${undeclaredFiles.join("\n- ")}` : "## Plan Divergence\n(no undeclared changed files detected)",
				"## Action Result",
				getFinalOutput(actionResult.messages) || actionResult.stderr || "(no action output)",
				"## Verifier Result",
				getFinalOutput(verifierResult.messages) || verifierResult.stderr || "(no verifier output)",
			].join("\n\n");

			return buildReport(params, allResults, finalText, startedAt, Date.now(), conversationMessageCount);
		} finally {
			await Promise.all(workerWorkspaceRoots.map((root) => rm(root, { recursive: true, force: true })));
		}
	});
}

function renderReport(report: ProRunReport, theme: any, expanded: boolean): string {
	const durationMs = Math.max(0, report.endedAt - report.startedAt);
	const seconds = (durationMs / 1000).toFixed(1);
	let text = theme.fg("accent", theme.bold("Pro Mode"));
	text += theme.fg("dim", ` ${report.strategy}/${report.mode} · ${seconds}s`);
	text += "\n";
	text += theme.fg("muted", shorten(report.model, 72));
	text += "\n";
	text += theme.fg(
		"muted",
		`runs=${report.expectedRuns} workers=${report.workerCount} critics=${report.criticCount} isolated=${report.isolatedWorkspaces} ctx=${report.contextMessageCount} cost=${formatCost(report.totalCost)}`,
	);

	for (const result of report.results.slice(0, expanded ? report.results.length : 6)) {
		const icon = result.exitCode === 0 ? theme.fg("success", "✓") : result.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
		text += "\n";
		text += `${icon} ${theme.fg("accent", result.label)} ${theme.fg("dim", `[${result.role}]`)}`;
		if (result.preview) text += `\n  ${theme.fg("muted", result.preview)}`;
		const usage = formatUsageStats(result.usage, result.model);
		if (usage) text += `\n  ${theme.fg("dim", usage)}`;
	}

	if (!expanded && report.results.length > 6) {
		text += `\n${theme.fg("dim", `… ${report.results.length - 6} more stage results`)}`;
	}

	text += "\n\n";
	text += report.finalText;
	return text;
}

function normalizeParams(input: {
	task: string;
	mode?: ProTaskMode;
	strategy?: ProStrategy;
	workers?: number;
	critics?: number;
	model?: string;
	isolatedWorkspaces?: boolean;
	yolo?: boolean;
	source: "command" | "tool";
}): ProRunParams {
	const mode = input.mode ?? "research";
	const strategy = input.strategy ?? "critique";
	const defaultWorkers = mode === "code" ? 6 : DEFAULT_WORKER_COUNT;
	const defaultCritics = mode === "code" ? 3 : DEFAULT_CRITIC_COUNT;
	const workerCount = Math.max(1, Math.min(input.workers ?? defaultWorkers, MAX_WORKERS));
	const criticCount = strategy === "critique" ? Math.max(0, Math.min(input.critics ?? defaultCritics, MAX_CRITICS)) : 0;
	const isolatedWorkspaces = input.isolatedWorkspaces ?? false;
	return {
		task: input.task.trim(),
		mode,
		strategy,
		workerCount,
		criticCount,
		model: input.model ?? DEFAULT_MODEL,
		isolatedWorkspaces,
		yolo: input.mode === "code" ? Boolean(input.yolo) : false,
		source: input.source,
	};
}

function parseCommandArgs(args: string, defaultMode: ProTaskMode): Omit<ProRunParams, "source"> {
	const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
	let mode: ProTaskMode = defaultMode;
	let strategy: ProStrategy = "critique";
	let workers: number | undefined;
	let critics: number | undefined;
	let model: string | undefined;
	let isolatedWorkspaces: boolean | undefined;
	let yolo = false;
	const taskParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i];
		const token = raw.replace(/^['"]|['"]$/g, "");
		if (token === "--single") {
			strategy = "single";
			continue;
		}
		if (token === "--fanout") {
			strategy = "fanout";
			continue;
		}
		if (token === "--critique") {
			strategy = "critique";
			continue;
		}
		if (token === "--research") {
			mode = "research";
			continue;
		}
		if (token === "--code") {
			mode = "code";
			continue;
		}
		if (token === "--direct") {
			isolatedWorkspaces = false;
			continue;
		}
		if (token === "--isolated") {
			isolatedWorkspaces = true;
			continue;
		}
		if (token === "--yolo") {
			yolo = true;
			continue;
		}
		if (token === "--workers" || token === "-w") {
			workers = Number(tokens[++i]?.replace(/^['"]|['"]$/g, "") ?? "");
			continue;
		}
		if (token === "--critics" || token === "-c") {
			critics = Number(tokens[++i]?.replace(/^['"]|['"]$/g, "") ?? "");
			continue;
		}
		if (token === "--model" || token === "-m") {
			model = tokens[++i]?.replace(/^['"]|['"]$/g, "");
			continue;
		}
		if (token === "--") {
			taskParts.push(...tokens.slice(i + 1).map((item) => item.replace(/^['"]|['"]$/g, "")));
			break;
		}
		taskParts.push(token);
	}

	return normalizeParams({
		task: taskParts.join(" "),
		mode,
		strategy,
		workers: Number.isFinite(workers) ? workers : undefined,
		critics: Number.isFinite(critics) ? critics : undefined,
		model,
		isolatedWorkspaces,
		yolo,
		source: "command",
	});
}

function renderBenchmarkReport(report: BenchmarkReport, theme: any): string {
	const durationMs = Math.max(0, report.endedAt - report.startedAt);
	let text = theme.fg("accent", theme.bold("Pro Benchmark"));
	text += theme.fg("dim", ` ${(durationMs / 1000).toFixed(1)}s`);

	for (const caseResult of report.results) {
		text += `\n\n${theme.fg("accent", caseResult.title)}${theme.fg("dim", ` (${caseResult.caseId})`)}`;
		for (const strategyResult of caseResult.strategies) {
			const icon = strategyResult.passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const duration = ((strategyResult.report.endedAt - strategyResult.report.startedAt) / 1000).toFixed(1);
			text += `\n${icon} ${theme.fg("muted", strategyResult.strategy.padEnd(8, " "))} ${theme.fg("dim", `exit=${strategyResult.exitCode} ${duration}s`)}`;
			const preview = shorten(strategyResult.report.finalText || strategyResult.stderr || strategyResult.stdout, 120);
			if (preview) text += `\n  ${theme.fg("muted", preview)}`;
		}
	}

	return text;
}

export default function proModeExtension(pi: ExtensionAPI) {
	if (process.env.PI_PRO_MODE_CHILD === "1") {
		return;
	}

	pi.registerMessageRenderer("pro-mode-report", (message, options, theme) => {
		const report = message.details as ProRunReport | undefined;
		if (!report) return new Text(message.content, 0, 0);
		return new Text(renderReport(report, theme, options.expanded), 0, 0);
	});

	pi.registerMessageRenderer("pro-benchmark-report", (message, _options, theme) => {
		const report = message.details as BenchmarkReport | undefined;
		if (!report) return new Text(message.content, 0, 0);
		return new Text(renderBenchmarkReport(report, theme), 0, 0);
	});

	async function confirmCodeRunIfNeeded(ctx: ExtensionContext, params: ProRunParams): Promise<boolean> {
		if (params.mode !== "code" || !ctx.hasUI || params.yolo) return true;
		const contextCount = countConversationMessages(ctx);
		const totalRuns = getExpectedRunCount(params, contextCount);
		const ok = await ctx.ui.confirm(
			"Run Pro code mode?",
			[
				`Task: ${shorten(params.task, 140)}`,
				`Runs: ${totalRuns} (${params.strategy})`,
				`Model: ${params.model}`,
				params.yolo ? "YOLO: enabled" : "YOLO: disabled",
				`Workers: read-only planning agents`,
				`Only one final action agent can edit the real workspace`,
				`Context available: ${contextCount} session messages`,
				"Planners may see broad chat history, but the writer and verifier will receive focused grounded briefs.",
				"This mode can edit files after a second plan approval step. Continue?",
			].join("\n"),
		);
		return ok;
	}

	pi.registerTool({
		name: "pro_mode",
		label: "Pro Mode",
		description:
			"Run a native Pi ensemble orchestration: multiple worker instances, optional critics, then a final integrator using the Fireworks Kimi model.",
		promptSnippet: "Use ensemble orchestration for hard tasks that benefit from multiple independent attempts and final synthesis.",
		promptGuidelines: [
			"Use this tool for especially hard tasks where one pass is likely not enough.",
			"Prefer mode=code when the task requires real file changes and integration in the current workspace.",
		],
		parameters: ProModeParams,
		async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
			const params = normalizeParams({ ...rawParams, source: "tool" });
			if (!params.task) {
				throw new Error("Task is required.");
			}
			if (!(await confirmCodeRunIfNeeded(ctx, params))) {
				return {
					content: [{ type: "text", text: "Canceled Pro Mode code run." }],
					details: undefined,
				};
			}

			const report = await runPipeline(ctx, params);
			onUpdate?.({
				content: [{ type: "text", text: report.finalText }],
				details: report,
			});
			return {
				content: [{ type: "text", text: report.finalText }],
				details: report,
			};
		},
		renderCall(args, theme) {
			const mode = args.mode ?? "research";
			const strategy = args.strategy ?? "critique";
			const workers = args.workers ?? DEFAULT_WORKER_COUNT;
			const critics = strategy === "critique" ? args.critics ?? DEFAULT_CRITIC_COUNT : 0;
			const text = `${theme.fg("toolTitle", theme.bold("pro_mode "))}${theme.fg("accent", `${strategy}/${mode}`)}${theme.fg("dim", ` workers=${workers} critics=${critics}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme) {
			const report = result.details as ProRunReport | undefined;
			if (!report) return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 0, 0);
			return new Text(renderReport(report, theme, options.expanded), 0, 0);
		},
	});

	async function runFromCommand(ctx: ExtensionContext, params: Omit<ProRunParams, "source"> | ProRunParams): Promise<void> {
		const normalized = "source" in params ? params : { ...params, source: "command" as const };
		if (!(await confirmCodeRunIfNeeded(ctx, normalized))) {
			ctx.ui.notify("Canceled Pro Mode code run.", "warning");
			return;
		}
		const report = await runPipeline(ctx, normalized);
		pi.sendMessage({
			customType: "pro-mode-report",
			content: report.finalText,
			display: true,
			details: report,
		});
		ctx.ui.notify(`Pro Mode finished: ${normalized.strategy}/${normalized.mode}`, "info");
	}

	async function runBenchmarkCase(ctx: ExtensionContext, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseResult> {
		const baseRoot = await mkdtemp(path.join(os.tmpdir(), `pi-pro-bench-${benchmarkCase.id}-`));
		const baseDir = path.join(baseRoot, "base");
		await fs.promises.mkdir(baseDir, { recursive: true });
		await benchmarkCase.setup(baseDir);

		const strategies: Array<{ strategy: ProStrategy; workers: number; critics: number; isolatedWorkspaces: boolean }> = [
			{ strategy: "single", workers: 1, critics: 0, isolatedWorkspaces: false },
			{ strategy: "fanout", workers: 4, critics: 0, isolatedWorkspaces: false },
			{ strategy: "critique", workers: 4, critics: 2, isolatedWorkspaces: false },
		];

		const strategyResults: BenchmarkStrategyResult[] = [];
		try {
			for (const [index, strategyConfig] of strategies.entries()) {
				if (ctx.hasUI) {
					ctx.ui.setWidget("pro-bench", [
						`Benchmark: ${benchmarkCase.title}`,
						`Strategy ${index + 1}/${strategies.length}: ${strategyConfig.strategy}`,
					]);
					ctx.ui.setStatus("pro-bench", `Benchmark ${benchmarkCase.id}: ${strategyConfig.strategy}`);
				}

				const targetRoot = await mkdtemp(path.join(os.tmpdir(), `pi-pro-bench-run-${benchmarkCase.id}-`));
				const targetDir = path.join(targetRoot, benchmarkCase.id);
				await cp(baseDir, targetDir, { recursive: true, preserveTimestamps: true });

				try {
					const report = await runPipeline(
						ctx,
						normalizeParams({
							task: benchmarkCase.task,
							mode: benchmarkCase.mode,
							strategy: strategyConfig.strategy,
							workers: strategyConfig.workers,
							critics: strategyConfig.critics,
							isolatedWorkspaces: strategyConfig.isolatedWorkspaces,
							source: "command",
						}),
						targetDir,
					);

					let exitCode = 0;
					let stdout = "";
					let stderr = "";
					if (benchmarkCase.testCommand) {
						const shell = await runShellCommand(benchmarkCase.testCommand, targetDir, ctx.signal);
						exitCode = shell.code;
						stdout = shell.stdout;
						stderr = shell.stderr;
					}

					strategyResults.push({
						strategy: strategyConfig.strategy,
						passed: exitCode === 0,
						exitCode,
						stdout,
						stderr,
						report,
					});
				} finally {
					await rm(targetRoot, { recursive: true, force: true });
				}
			}
		} finally {
			await rm(baseRoot, { recursive: true, force: true });
		}

		return {
			caseId: benchmarkCase.id,
			title: benchmarkCase.title,
			strategies: strategyResults,
		};
	}

	async function runBenchmarks(ctx: ExtensionContext, selection: string): Promise<void> {
		const cases = selection && selection !== "all"
			? BENCHMARK_CASES.filter((benchmarkCase) => benchmarkCase.id === selection)
			: BENCHMARK_CASES;

		if (cases.length === 0) {
			ctx.ui.notify(`No benchmark case found for: ${selection}`, "warning");
			return;
		}

		const startedAt = Date.now();
		const results: BenchmarkCaseResult[] = [];
		try {
			for (const benchmarkCase of cases) {
				results.push(await runBenchmarkCase(ctx, benchmarkCase));
			}
		} finally {
			if (ctx.hasUI) {
				ctx.ui.setWidget("pro-bench", undefined);
				ctx.ui.setStatus("pro-bench", undefined);
			}
		}

		const report: BenchmarkReport = {
			startedAt,
			endedAt: Date.now(),
			results,
		};

		pi.sendMessage({
			customType: "pro-benchmark-report",
			content: renderBenchmarkReport(report, { fg: (_color: string, value: string) => value, bold: (value: string) => value }),
			display: true,
			details: report,
		});
		ctx.ui.notify(`Pro benchmark finished: ${results.length} case(s)`, "info");
	}

	const runProCommand = async (args: string, ctx: ExtensionContext) => {
		const params = parseCommandArgs(args, "research");
		if (!params.task) {
			ctx.ui.notify("Usage: /pro [--single|--fanout|--critique] [--workers N] [--critics N] [--model ID] <task>", "warning");
			return;
		}
		await runFromCommand(ctx, params);
	};

	pi.registerCommand("pro", {
		description: "Run Pro Mode. Flags: --single | --fanout | --critique, --workers N, --critics N, --model ID",
		handler: async (args, ctx) => {
			await runProCommand(args, ctx);
		},
	});

	pi.registerCommand("p", {
		description: "Shortcut for /pro",
		handler: async (args, ctx) => {
			await runProCommand(args, ctx);
		},
	});

	const runProFastCommand = async (args: string, ctx: ExtensionContext) => {
		const parsed = parseCommandArgs(args, "research");
		if (!parsed.task) {
			ctx.ui.notify("Usage: /profast [--workers N] [--model ID] <task>", "warning");
			return;
		}
		await runFromCommand(ctx, {
			...parsed,
			strategy: "fanout",
			workerCount: Math.max(2, Math.min(parsed.workerCount || 4, 4)),
			criticCount: 0,
			mode: "research",
		});
	};

	pi.registerCommand("profast", {
		description: "Run a faster/lighter Pro Mode variant: 4 workers + 1 integrator by default",
		handler: async (args, ctx) => {
			await runProFastCommand(args, ctx);
		},
	});

	pi.registerCommand("pf", {
		description: "Shortcut for /profast",
		handler: async (args, ctx) => {
			await runProFastCommand(args, ctx);
		},
	});

	const runProCodeCommand = async (args: string, ctx: ExtensionContext) => {
		const params = parseCommandArgs(args, "code");
		if (!params.task) {
			ctx.ui.notify(
				"Usage: /pro-code [--single|--fanout|--critique] [--workers N] [--critics N] [--direct|--isolated] [--model ID] [--yolo] <task>",
				"warning",
			);
			return;
		}
		await runFromCommand(ctx, { ...params, mode: "code", isolatedWorkspaces: params.isolatedWorkspaces ?? false });
	};

	pi.registerCommand("pro-code", {
		description: "Run safe Pro Mode coding orchestration: read-only planners, one writer, one verifier. Use --yolo to skip approvals",
		handler: async (args, ctx) => {
			await runProCodeCommand(args, ctx);
		},
	});

	pi.registerCommand("pc", {
		description: "Shortcut for /pro-code",
		handler: async (args, ctx) => {
			await runProCodeCommand(args, ctx);
		},
	});

	const runProCodeFastCommand = async (args: string, ctx: ExtensionContext) => {
		const parsed = parseCommandArgs(args, "code");
		if (!parsed.task) {
			ctx.ui.notify("Usage: /procodefast [--workers N] [--direct|--isolated] [--model ID] [--yolo] <task>", "warning");
			return;
		}
		await runFromCommand(ctx, {
			...parsed,
			strategy: "fanout",
			workerCount: Math.max(2, Math.min(parsed.workerCount || 3, 3)),
			criticCount: 0,
			mode: "code",
			isolatedWorkspaces: parsed.isolatedWorkspaces ?? false,
		});
	};

	pi.registerCommand("procodefast", {
		description: "Run a faster/lighter coding Pro Mode variant with one writer and one verifier. Use --yolo to skip approvals",
		handler: async (args, ctx) => {
			await runProCodeFastCommand(args, ctx);
		},
	});

	pi.registerCommand("pcf", {
		description: "Shortcut for /procodefast",
		handler: async (args, ctx) => {
			await runProCodeFastCommand(args, ctx);
		},
	});

	pi.registerCommand("pro-bench", {
		description: "Run built-in Pro Mode code benchmarks. Usage: /pro-bench [case-id|all]",
		handler: async (args, ctx) => {
			const selection = args.trim() || "all";
			await runBenchmarks(ctx, selection);
		},
	});
}
