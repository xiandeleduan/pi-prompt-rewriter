# pi-prompt-rewriter

> Rewrite your rough instructions into clear, actionable prompts — before they reach the model.

A [pi](https://pi.dev) extension that intercepts every message you send and rewrites it using **your current model** plus recent conversation context. You type `那个超时改一下` ("tweak that timeout"); the model receives a complete, unambiguous instruction.

[中文说明 ↓](#中文说明)

**Contents:** [The problem](#the-problem) · [What it does](#what-it-does) · [Install](#install) · [Usage](#usage) · [Skip rules](#skip-rules-how-it-saves-you-money) · [Failure behavior](#failure-behavior) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [FAQ](#faq)

---

## The problem

Short, context-dependent instructions are the norm in real sessions:

```
那个超时改一下
```

A capable model can *usually* guess what you mean — but guessing is where wrong-file edits, over-broad changes, and "I wasn't sure what you meant" replies come from. Every ambiguity costs a round trip.

## What it does

```
You type:     那个超时改一下
              ↓  (rewritten with conversation context)
Model sees:   把请求的超时时间改长一点，改完告诉我改了哪个文件、
              哪个配置项、从多少改到多少。
```

The rewritten text **replaces** your message in the conversation, so you always see exactly what was sent.

## Install

### Option A — one command (pi package)

```bash
pi install git:github.com/xiandeleduan/pi-prompt-rewriter
```

Pin a release if you want stability:

```bash
pi install git:github.com/xiandeleduan/pi-prompt-rewriter@v1.0.0
```

Then `/reload` in a running session.

### Option B — single file, no package manager

```bash
curl -fsSL https://raw.githubusercontent.com/xiandeleduan/pi-prompt-rewriter/main/extensions/prompt-rewriter.ts \
  -o ~/.pi/agent/extensions/prompt-rewriter.ts
```

Or just download `extensions/prompt-rewriter.ts` and drop it into `~/.pi/agent/extensions/`. Then `/reload`.

**Requirements:** pi with an authenticated model provider. No other dependencies — this is a single self-contained file.

### Verify it loaded

After `/reload`, run `/rewrite`. You should see the status line under the editor:

```
自动重写 开  发送时重写 · balanced  [f2]
```

### Uninstall

```bash
# Option A
pi remove git:github.com/xiandeleduan/pi-prompt-rewriter

# Option B
rm ~/.pi/agent/extensions/prompt-rewriter.ts
```

Then `/reload`. No configuration or state is written outside the extension file, so removal leaves nothing behind.

## Usage

Automatic rewriting is **on by default**. Just type normally.

A status line under the editor always shows what will happen to your next message:

```
自动重写 开  发送时重写 · balanced  [f2]
```

| State | Meaning |
|---|---|
| `自动重写 开` | rewriting enabled |
| `自动重写 关` | rewriting disabled |
| `发送时重写 · balanced` | your next message will be rewritten, at `balanced` strength |
| `跳过（too short）` | this message is too short to be worth an API call — sent as-is |
| `自动重写已关` | rewriting is off, message sent verbatim |

### Commands

| Command | What it does |
|---|---|
| `/rewrite` | **View** the current draft in a multi-line viewer. Edit in place and save to write it back to the editor. |
| `/rewrite run` | Rewrite the draft right now (does not send) |
| `/rewrite on` / `off` / `toggle` | Enable / disable automatic rewriting |
| `/rewrite last` | Show the previous original vs. rewritten pair |
| `/rewrite stat` | Counters: rewritten / skipped / failed, API calls, total characters delta |
| `/rewrite style` | Pick strength via dialog |
| `/rewrite minimal` / `balanced` / `deep` | Set strength directly |

`current`, `show`, `view`, `draft`, `help`, `?` are aliases for the default view action.

### Shortcut

**`F2`** toggles automatic rewriting on/off.

#### Why not `Ctrl+=` or plain `=`?

Both are traps, and both were found the hard way:

- **`Ctrl+=`** is the standard terminal *zoom-in* binding. The terminal consumes it — pi never sees the keystroke. (`Ctrl+-` and `Ctrl+0` are the same story.)
- **Plain `=`** is worse. pi checks extension shortcuts *before* text input, and a match consumes the key:

  ```js
  handleInput(data) {
    if (!this.onExtensionShortcut?.(data)) {
      /* ...text editing... */
    }
  }
  ```

  Binding bare `=` would make it impossible to type `a = b`, `timeout=30`, or `--flag=value`.

`F2` is unclaimed in pi's built-in bindings and is never swallowed by terminals.

## Skip rules (how it saves you money)

Rewriting costs one API call. These cases are skipped automatically:

- Empty input
- `/` slash commands and `!` bash commands
- Fewer than 12 characters **and** fewer than 4 CJK characters (`好`, `继续`, `ok`)
- Pure punctuation / pure numbers
- Already-structured prompts (markdown headings, code fences, XML tags — over a length threshold)
- Mid-stream steering and queued follow-ups (latency-sensitive; rewriting would add ~2s)

## Failure behavior

Rewriting **never blocks sending**. If the model is unavailable, the API errors, the request times out (25s), or the response is empty, the original text is sent unchanged. You get a one-line warning, not a failed turn.

## Strengths

| Style | Behavior |
|---|---|
| `minimal` | Closest to your original words; only disambiguates |
| `balanced` | Default. Clarifies intent and adds obvious missing specifics |
| `deep` | Adds boundaries, edge cases, and how to verify the result |

## Configuration

Defaults live at the top of `extensions/prompt-rewriter.ts`. Edit them before copying the file, or fork and edit your own copy.

```ts
const DEFAULT_CONFIG = {
    enabled: true,        // start with automatic rewriting on
    style: "balanced",    // "minimal" | "balanced" | "deep"
    timeoutMs: 25_000,    // give up and send the original after this long
    contextMessages: 12,  // how many recent messages to include
    contextCharLimit: 1200, // per-message character cap
};
```

| Setting | Default | Effect |
|---|---|---|
| `enabled` | `true` | Whether rewriting starts on. `/rewrite off` overrides per session. |
| `style` | `balanced` | Default strength. `/rewrite style` changes it per session. |
| `timeoutMs` | `25000` | Above this, the original text is sent unchanged. |
| `contextMessages` | `12` | More context means better pronoun resolution but more tokens. |
| `contextCharLimit` | `1200` | Caps how much of each message is included. |

Runtime toggles (`/rewrite off`, `/rewrite deep`) apply to the **current session only** — they are not persisted across restarts.

## Troubleshooting

**`/rewrite` is not a recognized command**

The extension isn't loaded. Run `/reload`. If it still fails, confirm the file exists:

```bash
ls ~/.pi/agent/extensions/prompt-rewriter.ts
```

**F2 does nothing**

Some terminal multiplexers and editors capture F2. Check with `pi` inside a plain terminal first. If your setup captures it, change the constant near the top of the file:

```ts
const TOGGLE_SHORTCUT: Parameters<ExtensionAPI["registerShortcut"]>[0] = "f2";
```

Pick a key pi does not already bind. `f3` and `f4` are unclaimed. Avoid `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (terminal zoom) and any bare printable character.

**Messages are never rewritten**

Check the status line. `跳过（too short）` means the input hit a skip rule. `自动重写已关` means it's off — press `F2`. If it shows `发送时重写` but nothing changes, the rewrite likely failed; run `/rewrite stat` and look at the failed counter.

**Rewrites are too aggressive or too timid**

`/rewrite minimal` stays close to your wording; `/rewrite deep` adds constraints and verification steps.

**Status line is missing entirely**

It only renders in interactive TUI mode (`ctx.mode === "tui"`). Print, JSON, and RPC modes have no editor widget.

## FAQ

**Does it use extra tokens?**

Yes — one extra model call per rewritten message, plus up to ~1200 characters × 12 messages of context. Skip rules exist specifically to avoid paying for `好`, `/commands`, and pasted structured prompts.

**Does it rewrite my message history?**

No. It rewrites the outgoing message only. Previous turns are untouched.

**Which model does it use?**

Whichever model is currently active (`ctx.model`). No separate API key or provider configuration is needed.

**Can I see what was sent?**

The rewritten text replaces your message in the transcript, so it's always visible. `/rewrite last` shows the before/after pair.

**Does it work in non-interactive mode?**

Rewriting itself works (`pi -p` included), but skip rules apply and there is no status line. Note that `pi -p` does **not** dispatch slash commands, so `/rewrite` there is treated as plain text.

## Design notes

- **Context-aware**: pulls the last 12 messages (user + assistant text only; tool calls and results are filtered as noise) so pronouns and references resolve correctly.
- **No wrapper leakage**: the system prompt forbids preambles and code fences; a `stripWrapper()` pass also removes ` ``` ` fences and `"Here is the rewritten prompt:"` style prefixes as a second line of defense.
- **Crash-safe UI**: the status widget reads the editor inside `render()`, which runs in the TUI render loop. It caches the `ui` reference instead of holding the extension `ctx` (which goes stale after `/new`, `/fork`, `/resume`, `/reload`) and wraps everything in `try/catch` — a throw there would otherwise take down the process.
- **No cache pollution**: rewrite calls use `cacheRetention: "none"`.

## License

MIT

---

## 中文说明

**用当前模型，把你随口说的一句话重写成清晰的提示词，再发给模型。**

### 解决什么问题

真实会话里，你的指令通常很短、依赖上下文：

```
那个超时改一下
```

模型一般能猜对，但**猜**正是改错文件、改动过大、"我不确定你指的是哪个"的来源。每一次含糊都要多花一个来回。

### 做了什么

```
你输入：    那个超时改一下
            ↓  （结合对话上下文重写）
模型收到：  把请求的超时时间改长一点，改完告诉我改了哪个文件、
            哪个配置项、从多少改到多少。
```

重写后的文本会**替换**你的消息出现在对话里，所以你总能看到实际发出去的是什么。

### 安装

一条命令（pi package）：

```bash
pi install git:github.com/xiandeleduan/pi-prompt-rewriter
```

锁定版本：

```bash
pi install git:github.com/xiandeleduan/pi-prompt-rewriter@v1.0.0
```

或者下载 `extensions/prompt-rewriter.ts` 放进 `~/.pi/agent/extensions/`。然后 `/reload`。

**验证已加载**：`/reload` 后输入 `/rewrite`，输入框下方应出现状态条：

```
自动重写 开  发送时重写 · balanced  [f2]
```

**卸载**：

```bash
pi remove git:github.com/xiandeleduan/pi-prompt-rewriter   # 方式 A
rm ~/.pi/agent/extensions/prompt-rewriter.ts              # 方式 B
```

然后 `/reload`。插件不在外部写任何配置或状态，删除后不留残留。

**要求**：pi + 已认证的模型 provider。无其他依赖，单文件自包含。

### 使用

自动重写**默认开启**，正常打字即可。

输入框下方常驻显示下一条消息会发生什么：

```
自动重写 开  发送时重写 · balanced  [f2]
```

| 状态 | 含义 |
|---|---|
| `自动重写 开` | 重写已开启 |
| `自动重写 关` | 重写已关闭 |
| `发送时重写 · balanced` | 下一条会被重写，力度 balanced |
| `跳过（too short）` | 太短，不值得调 API，原样发送 |
| `自动重写已关` | 重写关闭，原样发送 |

### 命令

| 命令 | 作用 |
|---|---|
| `/rewrite` | **查看**当前待发送的提示词（多行查看器，可直接改完回填） |
| `/rewrite run` | 立刻重写当前输入框内容（不发送） |
| `/rewrite on` / `off` / `toggle` | 开 / 关自动重写 |
| `/rewrite last` | 看上次的原文 vs 重写版 |
| `/rewrite stat` | 统计：重写 / 跳过 / 失败、API 调用次数、累计字数变化 |
| `/rewrite style` | 对话框选力度 |
| `/rewrite minimal` / `balanced` / `deep` | 直接设力度 |

### 快捷键

**`F2`** 切换自动重写开关。

**为什么不用 `Ctrl+=` 或裸 `=`**（都是踩过的坑）：

- **`Ctrl+=`** 是终端的放大快捷键，会被终端截走，pi 根本收不到（`Ctrl+-`、`Ctrl+0` 同理）。
- **裸 `=`** 更糟。pi 的 `handleInput` **先检查扩展快捷键、再交给文本编辑**，命中即吞掉按键。绑裸 `=` 会导致无法输入 `a = b`、`timeout=30`、`--flag=value`。

`F2` 在 pi 内置绑定里未被占用，终端也不会截取。

### 跳过规则（怎么省钱）

重写要花一次 API 调用。以下情况自动跳过：

- 空输入
- `/` 斜杠命令、`!` bash 命令
- 短于 12 字符**且**少于 4 个中文字（`好`、`继续`、`ok`）
- 纯符号 / 纯数字
- 已经是结构化提示词的（markdown 标题、代码块、XML 标签，且有长度阈值）
- 流式过程中的打断（steer）和排队消息（followUp）——延迟敏感，重写会加约 2 秒

### 失败时的行为

**重写永远不会阻塞发送。** 模型不可用、API 报错、超时（25 秒）、返回空，都会用原话发送。只给一行提示，不会让这一轮失败。

### 力度

| 力度 | 行为 |
|---|---|
| `minimal` | 最接近原话，只做歧义澄清 |
| `balanced` | 默认。澄清意图，补上明显的缺失信息 |
| `deep` | 补边界情况、约束条件、验证方法 |

### 许可证

MIT

### 配置

默认值在 `extensions/prompt-rewriter.ts` 顶部：

```ts
const DEFAULT_CONFIG = {
    enabled: true,        // 启动时是否开启自动重写
    style: "balanced",    // "minimal" | "balanced" | "deep"
    timeoutMs: 25_000,    // 超过这个时间就放弃，用原话发送
    contextMessages: 12,  // 带多少条最近消息作上下文
    contextCharLimit: 1200, // 单条消息最多取多少字符
};
```

运行时的开关（`/rewrite off`、`/rewrite deep`）**只对当前会话生效**，重启后回到默认值。

### 常见问题

**`/rewrite` 提示不是命令**

扩展没加载。执行 `/reload`。仍不行就确认文件在：

```bash
ls ~/.pi/agent/extensions/prompt-rewriter.ts
```

**F2 没反应**

少数终端复用器/编辑器会截取 F2。先换一个干净终端试试。若确实被占，改文件顶部的常量：

```ts
const TOGGLE_SHORTCUT: Parameters<ExtensionAPI["registerShortcut"]>[0] = "f2";
```

换成 pi 未占用的键（`f3`、`f4` 都是空闲的）。**不要**用 `Ctrl+=` / `Ctrl+-` / `Ctrl+0`（终端缩放）或任何裸可打印字符。

**消息没有被重写**

看状态条：`跳过（too short）` 说明命中了跳过规则；`自动重写已关` 说明开关关着，按 `F2`；如果显示 `发送时重写` 但内容没变，可能重写失败了，用 `/rewrite stat` 看失败次数。

**重写太激进 / 太保守**

`/rewrite minimal` 贴近原话；`/rewrite deep` 会补约束条件和验证方法。

**状态条完全不显示**

它只在交互式 TUI（`ctx.mode === "tui"`）下渲染。print / JSON / RPC 模式没有输入框 widget。

### 常见疑问

**会多花 token 吗？**

会。每条被重写的消息多一次模型调用，外加最多约 1200 字符 × 12 条上下文。跳过规则就是为了避免为 `好`、`/commands`、粘贴的结构化提示词白花钱。

**会改我的历史消息吗？**

不会。只重写即将发出的这一条，历史消息不动。

**用哪个模型？**

当前激活的模型（`ctx.model`）。不需要单独配 API key 或 provider。

**能看到实际发出去的是什么吗？**

能。重写后的文本会替换你的消息出现在对话里。`/rewrite last` 可以看原文与重写版对照。

**非交互模式能用吗？**

重写本身能用（含 `pi -p`），但跳过规则照常生效，且没有状态条。注意 `pi -p` **不派发斜杠命令**，那里的 `/rewrite` 会被当成普通文本。
