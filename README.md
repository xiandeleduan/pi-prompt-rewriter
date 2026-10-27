# pi-prompt-rewriter

> Rewrite your rough instructions into clear, actionable prompts — before they reach the model.

A [pi](https://pi.dev) extension that intercepts every message you send and rewrites it using **your current model** plus recent conversation context. You type `那个超时改一下` ("tweak that timeout"); the model receives a complete, unambiguous instruction.

[中文说明 ↓](#中文说明)

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

Then `/reload` in a running session.

### Option B — single file, no package manager

```bash
curl -fsSL https://raw.githubusercontent.com/xiandeleduan/pi-prompt-rewriter/main/extensions/prompt-rewriter.ts \
  -o ~/.pi/agent/extensions/prompt-rewriter.ts
```

Or just download `extensions/prompt-rewriter.ts` and drop it into `~/.pi/agent/extensions/`. Then `/reload`.

**Requirements:** pi with an authenticated model provider. No other dependencies — this is a single self-contained file.

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

或者下载 `extensions/prompt-rewriter.ts` 放进 `~/.pi/agent/extensions/`。然后 `/reload`。

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
