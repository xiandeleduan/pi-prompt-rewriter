/**
 * Prompt Rewriter — 用当前模型把你这句话重写成更有效的提示词。
 *
 * 工作方式：
 *   你输入 → 拿最近对话上下文 + 你的原话 → 当前模型重写 → 用重写版替换原文发给模型
 *
 * 命令：
 *   /rewrite           查看当前待发送的提示词（多行查看器，可顺手改完回填）
 *   /rewrite run       立刻重写一次输入框内容（不发送）
 *   /rewrite on|off    开 / 关自动重写（toggle 切换）
 *   /rewrite last      看上次的原文 vs 重写版
 *   /rewrite stat      统计（重写 / 跳过 / 失败、API 调用次数）
 *   /rewrite style     选力度（balanced / minimal / deep）
 *
 * 快捷键：
 *   f2                 切换自动重写开/关
 *                      （不用 ctrl+= 是因为它被终端缩放截走；不用裸 = 是因为会吞掉等号输入）
 *
 * 输入框下方常驻状态：
 *   自动重写 开  发送时重写 · balanced  [f2]
 *
 * 跳过规则（不浪费调用）：
 *   - 空输入、/ 命令、! bash
 *   - 短于 4 个字或 12 个字符的（"好" "继续" "ok"）
 *   - 纯符号/纯数字
 *   - 已经明显是结构化提示词的（含 markdown 标题、编号列表、XML 标签）
 *   - steer / followUp（打断场景，延迟敏感）
 *   - 重写失败时静默降级为原话
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

type Style = "balanced" | "minimal" | "deep";

interface Config {
	enabled: boolean;
	style: Style;
	/** 重写请求的超时（毫秒） */
	timeoutMs: number;
	/** 上下文最多带多少条消息 */
	contextMessages: number;
	/** 单条上下文消息最多多少字符 */
	contextCharLimit: number;
}

const DEFAULT_CONFIG: Config = {
	enabled: true,
	style: "balanced",
	timeoutMs: 25_000,
	contextMessages: 12,
	contextCharLimit: 1200,
};

/** 短于这个长度就跳过（字符数，中文按字算） */
const MIN_CHARS = 12;
/** 中文至少这么多个字才值得重写 */
const MIN_CJK = 4;

/**
 * 短但依赖上下文的开头词。
 *
 * 注意：这只是第一道筛选，不是唯一依据。
 * 真正的判断在 shouldSkip 里的 hasResolvableContext()：
 * 短句 + 上下文里有可消解的实体 → 重写。
 */
const CONTEXT_DEPENDENT =
	/^(?:再|还|又|别|不要|不用|不是|不对|换个|换一种|重新|重来|为什么|为啥|怎么|如何|那|这|它|他|她|刚才|上面|之前|前面|其实|好像|感觉|应该|能不能|要不要|是不是|对不对|改|调|换|加|删|去掉|调大|调小|放大|缩小)|^(?:why|how|what|which|revert|undo|redo|again|faster|slower|bigger|smaller|change|fix|adjust|tweak|increase|decrease|make|try|no|not|nope|yes|ok|okay|continue|more|less|same|other|that|this|it|those|these|previous|last)\b/i;

/**
 * 短句里是否已经自带明确对象（不需要重写）。
 *
 * 命中任意一条就认为"用户说得够具体"，跳过：
 * - 含代码标识符：驼峰（timeoutMs）、下划线（max_retries）、带点（src/db.ts）
 * - 含路径分隔符
 * - 含反引号/引号/引号式引用
 * - 含数字 + 单位
 *
 * 注意：不能简单写成「3 个字母以上的英文单词」——
 * 那样 why / revert / faster 这类英文短指令会被误判成"已经够具体"而跳过。
 */
const SELF_CONTAINED =
	/[a-z][A-Z]|[A-Za-z]_[A-Za-z]|[A-Za-z]\.[A-Za-z]|[A-Za-z]\/[A-Za-z]|[A-Za-z]\d|\d[A-Za-z]|[A-Za-z]-[A-Za-z]|`|「|」|"|\d+\s*(?:秒|分钟|毫秒|次|个|条|行|字|%|px)/;

/**
 * 上下文里是否存在可被指代消解的实体。
 * 只看最近几条，且只找"像标识符/路径/数字配置"的东西。
 */
function hasResolvableContext(ctx: ExtensionContext): boolean {
	try {
		const branch = ctx.sessionManager.getBranch();
		let scanned = 0;
		for (let i = branch.length - 1; i >= 0 && scanned < 6; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry?.type !== "message") continue;
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractText(entry.message?.content);
			if (!text) continue;
			scanned++;
			// 出现标识符/路径/带值配置，说明有东西可以被"那个"指代
			if (/[A-Za-z_][A-Za-z0-9_]{2,}|\d+\s*(?:ms|s|秒|次)|[\w\-]+\.(?:ts|js|json|py|go|rs|md)/.test(text)) {
				return true;
			}
		}
	} catch {
		// 取不到上下文就当没有
	}
	return false;
}

/**
 * 切换自动重写开关的快捷键。
 *
 * 选 f2 的理由：
 * - `ctrl+=` / `ctrl+-` / `ctrl+0` 是终端缩放键，会被终端截走，到不了 pi
 * - 裸 `=` 会吞掉等号输入（pi 先查扩展快捷键再交给编辑器）
 * - f2 在 pi 内置绑定里未占用，终端也不会截取
 */
const TOGGLE_SHORTCUT: Parameters<ExtensionAPI["registerShortcut"]>[0] = "f2";

/**
 * 重写结果最多是原话的多少倍。
 * 超了就当作注水丢弃，用原话发送。
 */
const MAX_EXPANSION_RATIO = 3;

/**
 * 防注水的绝对下限（字符）。
 * 原话很短时（"再快点"）按倍数算太小，给个宽容的底线。
 */
const MIN_EXPANSION_FLOOR = 120;

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是一个提示词重写器。你的唯一任务是：把用户随口说的一句话，改写成一条更清晰、更有执行力的提示词，交给下游的 AI 编程助手。

## 你要做的

1. 读懂用户真正想干什么（结合对话上下文）
2. 把它重写成一条明确的指令，补齐上下文里已经确定的信息
3. 只输出重写后的提示词本身

## 重写原则

- **不改变意图**。用户想做什么就是做什么，不要自作主张扩大或缩小范围。
- **把指代替换掉**。"这个" "那个" "上面说的" → 换成上下文里的具体对象（文件名、函数名、报错内容、需求名）。
- **补上期望产出**。如果用户没说清楚要什么形式的结果，用上下文推断。
- **推断不出就不要编**。宁可保留模糊，也不要填"给出可执行的结论"这类万能话术。
  如果关键指代在上下文里确实找不到，就在重写里明确要求澄清，例如
  "（我不确定你指的是哪个 timeoutMs，请确认）"。
- **不要凭空添加约束**。像"只改这一处" "不要动其他逻辑" "保持现有风格"这种限制，
  只有当上下文里确实有依据（用户说过，或会话开头的设定里写了）才能加。
  上下文没说就不要加 —— 编出来的约束往往和用户的真实意图相反。
- **不要凭空添加背景事实**。上下文里没有的东西，一个字都不要写。特别是：
  - 不要说"刚才改的代码" "当前正在改的地方" —— 除非上下文里真的出现过改动
  - 不要说"之前那个方案" "上次提到的" —— 除非上下文里真的提过
  - 不要补文件名、函数名、变量名、报错信息
  上下文是空的、或者跟这句话无关时，就直接按字面意思重写，不要给它配一个假背景。
- **保留用户的语气和态度**。用户在生气就还是生气，用户在催就还是催。
- **长度控制**。一般 1-3 句就够。原话已经清楚就直接润色，不要注水。

## 绝对不要做的

- 不要回答用户的问题。你只重写，不执行。
- 不要输出解释、前言、后缀（"这是重写后的提示词："这种话一句都不要）。
- 不要用 markdown 代码块包裹输出。
- 不要编造上下文里没有的文件名、路径、报错信息。
- 不要加"请""麻烦你"这类客套。

## 输出格式

直接输出重写后的提示词正文。不要任何其他内容。`;

const STYLE_HINT: Record<Style, string> = {
	balanced: "",
	minimal:
		"\n\n## 本次额外要求\n\n保持克制：只做最小澄清。把模糊指代替换成具体对象，其余原样保留。不要补新的要求，不要扩写。",
	deep:
		"\n\n## 本次额外要求\n\n深度补全：除了基本澄清，还要补上边界情况、验证方法、失败时怎么处理。仍然不能改变用户的原始意图。",
};

// ---------------------------------------------------------------------------
// 跳过判断
// ---------------------------------------------------------------------------

const SKIP_PATTERNS: Array<{ test: (t: string) => boolean; reason: string }> = [
	{ test: (t) => t.startsWith("/"), reason: "slash command" },
	{ test: (t) => t.startsWith("!"), reason: "bash command" },
	{ test: (t) => /^\s*$/.test(t), reason: "empty" },
	// 纯符号 / 纯数字 / 纯 emoji
	{ test: (t) => !/[\p{L}\p{N}]/u.test(t), reason: "no letters" },
	{ test: (t) => /^[\d\s.,;:!?%+\-*/=()]+$/.test(t), reason: "numbers only" },
	// 已经结构化：markdown 标题 / 编号列表 / XML 标签 / 代码围栏
	// 标题 + 列表同时存在，说明用户已经写得很有条理，不用重写（不限长度）
	{ test: (t) => /^#{1,6}\s/m.test(t) && /^\s*(?:[-*+]|\d+[.)])\s/m.test(t), reason: "already structured" },
	{ test: (t) => /^#{1,6}\s/m.test(t) && t.length > 200, reason: "already structured" },
	{ test: (t) => /^```/m.test(t) && t.length > 300, reason: "already structured" },
	{ test: (t) => /^<\w+[\s>]/m.test(t) && t.length > 200, reason: "already structured" },
];

/**
 * 判断这句话要不要跳过重写。
 *
 * resolvable: 上下文里是否存在可被指代消解的实体。
 *   - 不传：不做上下文判断（纯文本规则），用于无 ctx 的场合
 *   - false：上下文没有可指代的东西，短句跳过
 *   - true：短句若含指代/动作词则重写
 */
function shouldSkip(text: string, resolvable?: boolean): string | null {
	const t = text.trim();
	if (t.length === 0) return "empty";

	for (const { test, reason } of SKIP_PATTERNS) {
		if (test(t)) return reason;
	}

	if (t.length < MIN_CHARS) {
		const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
		if (cjk >= MIN_CJK) return null;

		// 短句里有明确对象（timeoutMs、src/db.ts、30秒、`code`）→ 不用重写
		if (SELF_CONTAINED.test(t)) return "too short";

		// 短句以指代/动作词开头，且上下文里有可消解的实体 → 重写
		if (resolvable && CONTEXT_DEPENDENT.test(t)) return null;

		return "too short";
	}

	return null;
}

// ---------------------------------------------------------------------------
// 上下文提取
// ---------------------------------------------------------------------------

interface TextBlock {
	type: string;
	text?: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as TextBlock;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n").trim();
}

/**
 * 工具输出在上下文里保留多少字符。
 *
 * 工具结果是指代消解的关键（"把那个 3 改成 5" 里的 3 往往只在工具输出里出现过），
 * 但全文太长，所以只留开头一段。
 */
const TOOL_RESULT_PREVIEW = 300;

/**
 * 把一条 session entry 转成上下文里的一行。
 * 返回 null 表示这条不参与上下文（非消息、或没有文本）。
 */
function extractContextEntry(entry: unknown, cfg: Config): string | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
	if (e.type !== "message") return null;

	const msg = e.message;
	const role = msg?.role;
	if (!role) return null;

	// 工具结果：截断后保留，用于指代消解
	if (role === "toolResult") {
		let text = extractText(msg.content);
		if (!text) return null;
		if (text.length > TOOL_RESULT_PREVIEW) {
			text = `${text.slice(0, TOOL_RESULT_PREVIEW)}…[工具输出已截断]`;
		}
		const label = msg.toolName ? `工具输出(${msg.toolName})` : "工具输出";
		return `${label}${msg.isError ? "[失败]" : ""}: ${text}`;
	}

	if (role !== "user" && role !== "assistant") return null;

	let text = extractText(msg.content);
	if (!text) return null;

	if (text.length > cfg.contextCharLimit) {
		text = `${text.slice(0, cfg.contextCharLimit)}…[已截断]`;
	}

	return `${role === "user" ? "用户" : "助手"}: ${text}`;
}

/**
 * 取上下文：会话开头的设定 + 最近 N 条对话。
 *
 * 为什么两段都要：
 * - 只取最近 N 条时，会话开头定下的关键约束（"两个环境都要改"）会被挤出窗口，
 *   重写模型就会按默认习惯编出相反的约束。
 * - 工具结果被保留，否则"那个 3"这类指代无从消解。
 */
function buildContext(ctx: ExtensionContext, cfg: Config): string {
	const branch = ctx.sessionManager.getBranch();

	// 1. 固定保留第一条用户消息（通常包含任务设定/背景约束）
	let firstUserText = "";
	let firstUserIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		const text = extractText(entry.message.content);
		if (!text) continue;
		firstUserText =
			text.length > cfg.contextCharLimit
				? `${text.slice(0, cfg.contextCharLimit)}…[已截断]`
				: text;
		firstUserIndex = i;
		break;
	}

	// 2. 最近 N 条（跳过已被首条占用的那条，避免重复）
	const lines: string[] = [];
	let taken = 0;
	for (let i = branch.length - 1; i >= 0 && taken < cfg.contextMessages; i--) {
		if (i === firstUserIndex) continue;
		const line = extractContextEntry(branch[i], cfg);
		if (!line) continue;
		lines.unshift(line);
		taken++;
	}

	const parts: string[] = [];
	if (firstUserText) parts.push(`【会话开头的设定】\n用户: ${firstUserText}`);
	if (lines.length > 0) parts.push(`【最近对话】\n${lines.join("\n\n")}`);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// 重写核心
// ---------------------------------------------------------------------------

interface RewriteResult {
	ok: boolean;
	text: string;
	error?: string;
	ms: number;
}

async function rewrite(
	text: string,
	ctx: ExtensionContext,
	cfg: Config,
	signal?: AbortSignal,
): Promise<RewriteResult> {
	const started = Date.now();
	const model = ctx.model;

	if (!model) {
		return { ok: false, text, error: "no model", ms: 0 };
	}

	const context = buildContext(ctx, cfg);
	const userPayload = context
		? `<对话上下文>\n${context}\n</对话上下文>\n\n<用户刚才说的话>\n${text}\n</用户刚才说的话>\n\n把"用户刚才说的话"重写成一条清晰的提示词。`
		: `<用户刚才说的话>\n${text}\n</用户刚才说的话>\n\n把这段话重写成一条清晰的提示词。`;

	// 超时 + 外部取消
	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), cfg.timeoutMs);
	const combined = signal
		? AbortSignal.any([signal, timeoutController.signal])
		: timeoutController.signal;

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: SYSTEM_PROMPT + STYLE_HINT[cfg.style],
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPayload }],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal: combined,
				cacheRetention: "none",
				// 重写是"忠实转述"任务，不是创作 —— 低温度减少随机发挥
				temperature: 0.2,
				// 重写结果不该长到哪去；硬上限防止模型注水
				maxTokens: 400,
			},
		);

		if (response.stopReason === "aborted") {
			return { ok: false, text, error: "aborted", ms: Date.now() - started };
		}
		if (response.stopReason === "error") {
			return {
				ok: false,
				text,
				error: response.errorMessage ?? "provider error",
				ms: Date.now() - started,
			};
		}

		const out = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		// 清理模型可能加的包装
		const cleaned = stripWrapper(out);
		if (!cleaned) {
			return { ok: false, text, error: "empty rewrite", ms: Date.now() - started };
		}

		// 防注水：重写结果远超原话就丢弃，用原话发送。
		// 否则模型会把一句话扩成一段废话，反而降低信噪比。
		const allowed = Math.max(text.length * MAX_EXPANSION_RATIO, MIN_EXPANSION_FLOOR);
		if (cleaned.length > allowed) {
			return { ok: false, text, error: "rewrite too verbose", ms: Date.now() - started };
		}

		// 防背景幻觉：提示词已经禁止编造"刚才改的代码"这类背景，
		// 但模型偶尔仍会违反。这里做代码级兜底：
		// 输出里出现这类词，而上下文里根本没有对应的改动痕迹 → 剥掉这句。
		const guarded = stripFabricatedBackground(cleaned, context);

		return { ok: true, text: guarded, ms: Date.now() - started };
	} catch (err) {
		return {
			ok: false,
			text,
			error: err instanceof Error ? err.message : String(err),
			ms: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 输出里“编造背景”的说法。
 * 这些词只能在上文真的存在对应内容时使用。
 */
const FABRICATED_BACKGROUND =
	/(?:刚才|刚刚|刚|上次|之前|前面)(?:改|动|写|做|说|提|讨论|聊)(?:过)?的?|(?:正在|当前正在)(?:改|修改|编辑|做|处理)的?|当前正在处理|刚才那(?:个|些|次)|上面那(?:个|些)/;

/**
 * 剥掉编造的背景描述。
 *
 * 提示词里已经要求“不要凭空添加背景事实”，但模型仍会偶发违反
 * （实测空会话下输入“加个日志”会得到“在当前正在修改的代码里加日志输出”）。
 *
 * 处理方式：
 * - 若上下文里确实有改动痕迹（改/修改/已改/重构 等），保留原文
 * - 否则把命中的短语替换成中性词（“当前代码”），不整句丢弃，
 *   因为句子的其余部分（“加日志输出”）仍然是用户要的
 */
function stripFabricatedBackground(text: string, context: string): string {
	if (!FABRICATED_BACKGROUND.test(text)) return text;

	// 上下文里真有改动痕迹 → 模型没编，原样保留
	if (/(?:改|修改|重构|更新|替换|删除|新增|已改|改成)/.test(context)) return text;

	return text
		.replace(/在(?:当前|刚才)?正在(?:改|修改|编辑|做|处理)的?代码(?:里|中|处)?/g, "在代码里")
		.replace(/当前正在处理(?:的)?(?:代码|逻辑|部分)?/g, "当前代码")
		.replace(/(?:刚才|刚刚|刚|上次|之前|前面)(?:改|动|写|做|说|提|讨论|聊)(?:过)?的?(?:代码|改动|地方|那部分|内容)?/g, "当前代码")
		.replace(/当前正在(?:改|修改|编辑)的/g, "当前")
		.replace(/刚才那(?:个|些|次)/g, "")
		.replace(/上面那(?:个|些)/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** 去掉模型爱加的 ``` 围栏和 "这是重写后的提示词：" 前缀 */
function stripWrapper(text: string): string {
	let out = text.trim();

	// 整个被代码块包住
	const fence = out.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
	if (fence) out = fence[1].trim();

	// 常见前缀
	out = out.replace(
		/^(?:这是(?:重写|改写|优化)(?:后|之后)?的?(?:提示词|prompt|版本)[:：]?\s*|(?:重写|改写)(?:后|之后)?的?(?:提示词|prompt)[:：]\s*|Rewritten prompt[:：]\s*)/i,
		"",
	);

	return out.trim();
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

interface Stats {
	rewritten: number;
	skipped: number;
	failed: number;
	/** 重写后比原文多了/少了多少字符（正数=变长） */
	deltaChars: number;
	/** 实际发出的模型调用次数（含失败） */
	apiCalls: number;
}

/** 上一次重写的原文与结果，供 /rewrite last 查看 */
interface LastRewrite {
	original: string;
	rewritten: string;
	ms: number;
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const cfg: Config = { ...DEFAULT_CONFIG };
	const stats: Stats = { rewritten: 0, skipped: 0, failed: 0, deltaChars: 0, apiCalls: 0 };
	let lastRewrite: LastRewrite | undefined;

	/** 正在重写中，避免重入 */
	let busy = false;

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"prompt-rewriter",
			cfg.enabled ? `⟳ rewrite:${cfg.style}` : undefined,
		);
	};

	// ------------------------------------------------------------------
	// 主钩子：拦截输入并重写
	// ------------------------------------------------------------------
	pi.on("input", async (event: InputEvent, ctx) => {
		if (!cfg.enabled) return { action: "continue" as const };
		if (event.source !== "interactive") return { action: "continue" as const };
		// steer / followUp：用户正在打断或排队，重写会拖慢感知延迟，直接放行
		if (event.streamingBehavior) return { action: "continue" as const };
		if (busy) return { action: "continue" as const };

		const original = event.text;
		const skipReason = shouldSkip(original, hasResolvableContext(ctx));
		if (skipReason) {
			stats.skipped++;
			return { action: "continue" as const };
		}

		busy = true;
		stats.apiCalls++;
		const started = Date.now();

		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage(`重写提示词中… (${ctx.model?.id ?? "?"})`);
		}

		try {
			const result = await rewrite(original, ctx, cfg, ctx.signal);

			if (!result.ok) {
				stats.failed++;
				if (ctx.hasUI && result.error !== "aborted") {
					ctx.ui.notify(`提示词重写失败，已用原话发送：${result.error}`, "warning");
				}
				return { action: "continue" as const };
			}

			// 重写结果和原话几乎一样 → 不折腾，但给个轻提示，
			// 否则用户看到状态条写着"会重写"却什么都没发生，会以为插件挂了。
			if (normalizeForCompare(result.text) === normalizeForCompare(original)) {
				stats.skipped++;
				if (ctx.hasUI) {
					ctx.ui.setStatus("prompt-rewriter-last", `⟳ 原话已足够清晰`);
				}
				return { action: "continue" as const };
			}

			stats.rewritten++;
			const delta = result.text.length - original.length;
			stats.deltaChars += delta;
			lastRewrite = { original, rewritten: result.text, ms: result.ms };

			// 成功不弹窗（重写版本身就显示在对话里），只在状态栏留个紧凑印记
			if (ctx.hasUI) {
				ctx.ui.setStatus(
					"prompt-rewriter-last",
					`⟳ ${original.length}→${result.text.length}字`,
				);
			}

			return { action: "transform" as const, text: result.text, images: event.images };
		} finally {
			busy = false;
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
		}
	});

	// ------------------------------------------------------------------
	// /rewrite 命令
	// ------------------------------------------------------------------
	pi.registerCommand("rewrite", {
		description: "提示词重写：/rewrite 看当前待发送提示词，on|off|run|last|stat|style",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "current", label: "current — 查看当前待发送的提示词" },
				{ value: "on", label: "on — 开启自动重写" },
				{ value: "off", label: "off — 关闭自动重写" },
				{ value: "toggle", label: "toggle — 切换开关" },
				{ value: "run", label: "run — 立刻重写一次输入框内容" },
				{ value: "last", label: "last — 上次原文 vs 重写版" },
				{ value: "stat", label: "stat — 统计" },
				{ value: "style", label: "style — 选力度" },
				{ value: "balanced", label: "balanced — 平衡力度" },
				{ value: "minimal", label: "minimal — 克制力度" },
				{ value: "deep", label: "deep — 深度力度" },
			];
			const hits = subs.filter((s) => s.value.startsWith(prefix.trim()));
			return hits.length > 0 ? hits : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			// ---- 查看当前待发送提示词（默认动作）----
			const isView =
				arg === "" ||
				arg === "current" ||
				arg === "show" ||
				arg === "view" ||
				arg === "draft" ||
				arg === "help" ||
				arg === "?";

			if (isView) {
				const draft = ctx.ui.getEditorText();
				const trimmed = draft.trim();

				// 空输入框：直接给出简短说明，不弹窗打扰
				if (!trimmed) {
					ctx.ui.notify(
						[
							"📝 输入框是空的 —— 现在没有待发送的提示词。",
							``,
							`自动重写：${cfg.enabled ? "✅ 开启" : "⏸ 关闭"}  力度：${cfg.style}`,
							`写好一句话后，发送时会自动重写；或先写内容再 /rewrite 查看。`,
							``,
							`/rewrite on|off     开关自动重写（快捷键 ${TOGGLE_SHORTCUT}）`,
							`/rewrite run        立刻重写输入框内容`,
							`/rewrite last       上次原文 vs 重写版`,
							`/rewrite stat       统计`,
							`/rewrite style      选力度（minimal|balanced|deep）`,
						].join("\n"),
						"info",
					);
					return;
				}

				const lines = draft.split("\n");
				const chars = draft.length;
				const preview = lines[0].slice(0, 60) + (lines[0].length > 60 ? "…" : "");
				const skip = shouldSkip(trimmed, hasResolvableContext(ctx));

				// 有 UI 时用多行编辑器展示全文，可滚动查看、也可顺手改完回填
				if (ctx.mode === "tui") {
					const shown = await ctx.ui.editor(
						`当前待发送的提示词（${chars} 字 / ${lines.length} 行）—— 可直接修改，保存后回填输入框`,
						draft,
					);
					// 取消（undefined）视为不修改；有改动则回填
					if (typeof shown === "string" && shown !== draft) {
						ctx.ui.setEditorText(shown);
						const delta = shown.length - draft.length;
						const sign = delta >= 0 ? "+" : "";
						ctx.ui.notify(
							delta === 0
								? `已更新输入框（${shown.length} 字，长度未变）。回车发送。`
								: `已更新输入框（${draft.length} → ${shown.length} 字，${sign}${delta}）。回车发送。`,
							"info",
						);
					}
					return;
				}

				// 非 TUI（RPC/无完整 UI）：退回文本通知
				ctx.ui.notify(
					[
						`📝 当前待发送的提示词（${chars} 字 / ${lines.length} 行）`,
						``,
						draft,
						``,
						`发送时${skip ? `会跳过重写（${skip}）` : `将自动重写（力度 ${cfg.style}）`}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// ---- on / off / toggle ----
			if (arg === "on" || arg === "off") {
				cfg.enabled = arg === "on";
				updateStatus(ctx);
				ctx.ui.notify(`提示词重写已${cfg.enabled ? "开启" : "关闭"}`, "info");
				return;
			}

			if (arg === "toggle") {
				cfg.enabled = !cfg.enabled;
				updateStatus(ctx);
				ctx.ui.notify(`提示词重写已${cfg.enabled ? "开启" : "关闭"}`, "info");
				return;
			}

			// ---- run：主动重写一次输入框内容（不发送）----
			if (arg === "run" || arg === "rewrite" || arg === "now") {
				const draft = ctx.ui.getEditorText().trim();
				if (!draft) {
					ctx.ui.notify("输入框是空的，先写点什么再 /rewrite run", "warning");
					return;
				}

				const skip = shouldSkip(draft, hasResolvableContext(ctx));
				if (skip) {
					ctx.ui.notify(`这句会跳过重写（${skip}），无需手动执行。`, "info");
					return;
				}

				ctx.ui.notify(`重写中… (${ctx.model?.id ?? "?"})`, "info");
				const result = await rewrite(draft, ctx, cfg, ctx.signal);

				if (!result.ok) {
					ctx.ui.notify(`重写失败：${result.error}`, "error");
					return;
				}

				// 记录，供 /rewrite last 查看
				lastRewrite = { original: draft, rewritten: result.text, ms: result.ms };
				stats.rewritten++;
				stats.deltaChars += result.text.length - draft.length;

				ctx.ui.setEditorText(result.text);
				ctx.ui.notify(
					`已重写 (${draft.length} → ${result.text.length} 字, ${result.ms}ms)。检查后自行回车发送。`,
					"info",
				);
				return;
			}

			// ---- stat ----
			if (arg === "stat" || arg === "stats") {
				const total = stats.rewritten + stats.skipped + stats.failed;
				const rate = total > 0 ? ((stats.rewritten / total) * 100).toFixed(0) : "0";
				const sign = stats.deltaChars >= 0 ? "+" : "";
				ctx.ui.notify(
					[
						`状态：${cfg.enabled ? "开启" : "关闭"}  力度：${cfg.style}`,
						`重写 ${stats.rewritten} / 跳过 ${stats.skipped} / 失败 ${stats.failed}（重写率 ${rate}%）`,
						`模型调用 ${stats.apiCalls} 次  累计增减 ${sign}${stats.deltaChars} 字`,
					].join("\n"),
					"info",
				);
				return;
			}

			// ---- last：看上次的原文 vs 重写版 ----
			if (arg === "last") {
				if (!lastRewrite) {
					ctx.ui.notify("还没有重写过任何消息", "info");
					return;
				}
				ctx.ui.notify(
					[
						`—— 原话（${lastRewrite.original.length} 字）——`,
						lastRewrite.original,
						``,
						`—— 重写版（${lastRewrite.rewritten.length} 字, ${lastRewrite.ms}ms）——`,
						lastRewrite.rewritten,
					].join("\n"),
					"info",
				);
				return;
			}

			// ---- style ----
			if (arg === "style") {
				const choice = await ctx.ui.select("重写力度", [
					"balanced — 平衡（默认）",
					"minimal — 克制，只做最小澄清",
					"deep — 深度，补边界情况和验证方法",
				]);
				if (!choice) return;
				cfg.style = choice.split(" ")[0].split("—")[0].trim() as Style;
				updateStatus(ctx);
				ctx.ui.notify(`重写力度：${cfg.style}`, "info");
				return;
			}

			if (arg === "minimal" || arg === "balanced" || arg === "deep") {
				cfg.style = arg;
				updateStatus(ctx);
				ctx.ui.notify(`重写力度：${cfg.style}`, "info");
				return;
			}

			// ---- 未知子命令 ----
			ctx.ui.notify(`未知子命令：${arg}（试试 /rewrite 看帮助）`, "warning");
		},
	});

	// ------------------------------------------------------------------
	// 快捷键：f2 切换自动重写开/关
	//
	// 为什么不用 ctrl+= ：那是终端放大快捷键，会被终端截走，根本到不了 pi。
	// 为什么不用裸 `=` ：pi 的 handleInput 会先检查扩展快捷键（命中就 return true），
	//   裸 `=` 会吞掉所有等号输入，导致无法打出 a = b / timeout=30。
	// f2 在 pi 内置绑定里未被占用，且终端不会截取，是安全选择。
	// ------------------------------------------------------------------
	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "切换提示词自动重写开/关",
		handler: async (ctx) => {
			cfg.enabled = !cfg.enabled;
			updateStatus(ctx);
			ctx.ui.notify(`提示词重写已${cfg.enabled ? "开启" : "关闭"}`, "info");
		},
	});

	// ------------------------------------------------------------------
	// 启动时挂状态 + 常驻提示词状态条
	// ------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
		mountDraftWidget(ctx, cfg);
	});

	pi.on("session_shutdown", async () => {
		// 没有需要释放的资源，占位以保持对称
	});
}

// ---------------------------------------------------------------------------
// 输入框下方的常驻提示词状态
// ---------------------------------------------------------------------------

/**
 * 在输入框下方挂一条常驻状态：实时反映当前待发送提示词的行数/字数/预览。
 *
 * 实现要点：widget 的工厂函数只在 setWidget 时调用一次，返回的组件会在每次
 * TUI 重绘（按键、流式输出等）时调用 render()。因此把"读编辑器内容"放在
 * render() 里，就能跟随输入实时更新，无需拦截每一次按键。
 */
function mountDraftWidget(ctx: ExtensionContext, cfg: Config): void {
	if (ctx.mode !== "tui") return;

	const WIDGET_KEY = "prompt-rewriter-draft";

	// 只捕获一次性、不会失效的东西：
	// ctx 本身在 session 被替换/重载后会 stale，访问 ctx.ui 会抛错。
	// 所以这里把 ui 的引用先取出来存下，并全部用 try/catch 包住。
	const ui = ctx.ui;

	// 状态条在 render() 里跑，每次重绘都调 getBranch() 太浪费。
	// 每 2 秒最多算一次"上下文里有没有可消解实体"，其余时间用缓存值。
	let cachedResolvable = false;
	let cacheAt = 0;
	const refreshResolvable = () => {
		const now = Date.now();
		if (now - cacheAt < 2000) return cachedResolvable;
		cacheAt = now;
		try {
			cachedResolvable = hasResolvableContext(ctx);
		} catch {
			cachedResolvable = false;
		}
		return cachedResolvable;
	};

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render(_width: number): string[] {
				// render() 跑在 TUI 渲染主循环里，抛错会让整个进程崩。
				// 任何异常一律降级为空渲染。
				try {
					const text = ui.getEditorText().trim();

					// 两项：自动重写开关状态 + 当前重写状态
					const toggle = cfg.enabled
						? theme.fg("success", "自动重写 开")
						: theme.fg("warning", "自动重写 关");

					// 空输入框也常驻显示，只是没有"跳过/发送时重写"这类跟内容相关的状态
					// 注意：状态条在 render() 里跑，不能每次调 getBranch()（会拖慢重绘）。
					// 所以这里用缓存的"上下文是否有可消解实体"，每 2 秒重算一次。
					const skip = text ? shouldSkip(text, refreshResolvable()) : null;
					const state = skip
						? theme.fg("muted", `跳过（${skip}）`)
						: cfg.enabled
							? theme.fg("accent", `发送时重写 · ${cfg.style}`)
							: theme.fg("warning", "自动重写已关");

					// 快捷键提示：告诉用户怎么切
					const hint = theme.fg("dim", `[${TOGGLE_SHORTCUT}]`);

					return [`${toggle}  ${state}  ${hint}`];
				} catch {
					// ctx 已失效 / 编辑器不可用 / 任何意外 —— 静默降级，不拖垮 TUI
					return [];
				}
			},
			invalidate() {
				// 无缓存，无需失效
			},
		}),
		{ placement: "belowEditor" },
	);
}

function normalizeForCompare(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}
