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
 * 切换自动重写开关的快捷键。
 *
 * 选 f2 的理由：
 * - `ctrl+=` / `ctrl+-` / `ctrl+0` 是终端缩放键，会被终端截走，到不了 pi
 * - 裸 `=` 会吞掉等号输入（pi 先查扩展快捷键再交给编辑器）
 * - f2 在 pi 内置绑定里未占用，终端也不会截取
 */
const TOGGLE_SHORTCUT: Parameters<ExtensionAPI["registerShortcut"]>[0] = "f2";

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
- **补上期望产出**。如果用户没说清楚要什么形式的结果，用上下文推断；推断不出就写"给出可执行的结论"。
- **补上必要的约束**。只补上下文里已经隐含的约束（比如"不要改其他文件"、"保持现有风格"），不要凭空发明需求。
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
	{ test: (t) => /^#{1,6}\s/m.test(t) && t.length > 200, reason: "already structured" },
	{ test: (t) => /^```/m.test(t) && t.length > 300, reason: "already structured" },
	{ test: (t) => /^<\w+[\s>]/m.test(t) && t.length > 200, reason: "already structured" },
];

function shouldSkip(text: string): string | null {
	const t = text.trim();
	if (t.length === 0) return "empty";

	for (const { test, reason } of SKIP_PATTERNS) {
		if (test(t)) return reason;
	}

	// 太短：字符数不够，或中文字数不够
	if (t.length < MIN_CHARS) {
		const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
		if (cjk < MIN_CJK) return "too short";
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
 * 取最近 N 条对话作为重写上下文。
 * 只取 user/assistant 的纯文本，跳过 tool call 和 tool result（噪音太大，且会撑爆）。
 */
function buildContext(ctx: ExtensionContext, cfg: Config): string {
	const branch = ctx.sessionManager.getBranch();
	const lines: string[] = [];
	let taken = 0;

	for (let i = branch.length - 1; i >= 0 && taken < cfg.contextMessages; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const msg = entry.message as { role?: string; content?: unknown };
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		let text = extractText(msg.content);
		if (!text) continue;

		if (text.length > cfg.contextCharLimit) {
			text = `${text.slice(0, cfg.contextCharLimit)}…[已截断]`;
		}

		lines.unshift(`${role === "user" ? "用户" : "助手"}: ${text}`);
		taken++;
	}

	return lines.join("\n\n");
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
			{ signal: combined, cacheRetention: "none" },
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

		return { ok: true, text: cleaned, ms: Date.now() - started };
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
		const skipReason = shouldSkip(original);
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

			// 重写结果和原话几乎一样 → 不折腾
			if (normalizeForCompare(result.text) === normalizeForCompare(original)) {
				stats.skipped++;
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
				const skip = shouldSkip(trimmed);

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

				const skip = shouldSkip(draft);
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
					const skip = text ? shouldSkip(text) : null;
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
