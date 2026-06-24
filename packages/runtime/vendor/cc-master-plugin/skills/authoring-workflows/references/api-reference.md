# API reference——primitive 签名、opts、cache key、failure 语义

> `Workflow` 工具契约的速查。下面每个签名和选项都出自工具 schema——**没有一个是编造的**。
> 没列在这里的选项就是不存在，别去传它。

## `agent(prompt, opts?) → Promise<string | object>`

派生一个 fresh-context 的 leaf subagent。

- **返回：** 不给 `schema` 时返回 leaf 的最终文本（一个 `string`）；给了 `schema` 时返回
  一个匹配 `schema` 的**已校验对象**（校验在 tool-call 层完成——不用 `JSON.parse`）。被用户
  跳过的 agent 返回 **`null`**（`.filter(Boolean)` 就是为它而设）。

### `opts`（全部可选）

| 选项 | 类型 | 含义 |
|---|---|---|
| `label` | string | 在 `/workflows` 里显示的名字。纯装饰——**绝不**进 cache。 |
| `phase` | string | 把 agent 归进一个命名的 progress group。必须匹配某个 `meta.phases[].title`。纯装饰——绝不进 cache。**在并发的 `parallel`/`pipeline` stage 内部，优先用 `opts.phase`、而非全局的 `phase()` 调用**（避免 group-attribution race）。 |
| `schema` | JSON Schema | 强制结构化输出，`agent()` 返回已校验对象。**改它会让 cache 失效。** |
| `model` | string | 覆盖 model。默认继承 main-loop 的 model——契约说这个默认「几乎总是对的」，所以拿不准就别传。**改它会让 cache 失效。** |
| `isolation` | `'worktree'` | 让这个 agent 在一个全新的 git worktree 里跑。**只**在并行 agent 会改到同一批文件、可能冲突时才用（每个 agent 约 200–500 ms + 占磁盘）。**改它会让 cache 失效。** |
| `agentType` | string | 改用一个自定义 subagent 类型，从与 Agent 工具同一个 registry 里解析。**改它会让 cache 失效。** |

## `parallel(thunks) → Promise<any[]>`  — BARRIER

- **参数：** 一个 **thunk 数组**——`[() => agent(...), () => agent(...)]`。绝不是
  promise 数组（裸 promise 会立刻启动、绕开并发限流器）。
- **Barrier：** 等齐**全部** thunk，再按输入顺序返回一个结果数组。
- **Failure：** 抛错的 thunk → 对应槽位变 `null`。这个调用**绝不 reject**。所以事后总要
  `.filter(Boolean)`。
- **Cap：** 单次调用 ≤ 4,096 个 thunk。

## `pipeline(items, ...stages) → Promise<any[]>`  — NO BARRIER

- **参数：** 先一个 `items` 数组，再跟一个或多个 stage 回调。
- **流式：** 每个 item 独立流过所有 stage——stage 之间没有 barrier。
- **Stage 签名：** 每个 stage 回调收到 `(prevResult, originalItem, index)`。
- **Failure：** 抛错的 stage 把那个 item 降为 `null`，并跳过它余下的 stage。
- **Cap：** 单次调用 ≤ 4,096 个 item。

## `phase(title) → void`

开启一个命名的 progress group；此后派生的 agent 都归进这个 group。`title` 必须精确匹配
某个 `meta.phases[].title`。在并发 stage 内部，改用 `opts.phase`（不会 race）。

## `log(message) → void`

在 progress tree 上方发一行叙述。用它来**把丢掉的东西明明白白说出来**——top-N 截断、
没重试、采样——免得这种悄悄的收窄被当成「full coverage」。

## `workflow(nameOrRef, args?) → Promise<any>`

内联跑另一个 workflow，并返回它的返回值。传一个 saved workflow 名字或 `{scriptPath}`。

- **只有一层：** 在一个*子* workflow *内部*再调 `workflow()` 会抛错。
- 子 workflow **共用**本次 run 的并发 cap、agent 计数器、abort signal 和 token budget。
- 名字未知 / 路径读不到 / 子 workflow 语法错误，都会**抛错**——用 `catch` 接住、优雅降级。
- 由 `assets/examples/nested-workflow-composition.js` 演示（逐项的 child run +
  catch-and-degrade fallback）。

## `args`——注入的全局

传给 `Workflow` 工具的输入值，原样作为脚本全局暴露。**传真正的 JSON 值（数组 / 对象），
别传 JSON 字符串**——被 stringify 过的 list 会以 `string` 的形态抵达，`args.filter` /
`args.map` 一调就抛错。什么都没传时为 `undefined`。

## `budget`——注入的全局

`{ total, spent(), remaining() }`，一个共享的 output-token 池。

- `budget.total` = 用户给的 `'+500k'` 式目标；没设就是 `null`。
- `budget.spent()` = 本回合的 output token，**跨 main loop 和所有 workflow 共享**
  （不是 per-workflow）。
- `budget.remaining()` = `max(0, total − spent())`；没设目标时是 `Infinity`。
- 目标是一道**硬上限**：`spent()` 一旦触到 `total`，新的 `agent()` 调用就**抛错**。
- **budget loop 永远用 `budget.total` 来守：**
  `while (budget.total && budget.remaining() > 50_000) { ... }`——少了这个守卫，
  `remaining()` 就是 `Infinity`，loop 会一路冲到 1,000-agent 的 cap。

## Cache key——四要素（`agent()` 的 resume 身份）

Resume 身份是按内容算的（见 `mechanism.md` §5）。一个 `agent()` 调用的 cache 身份由
**四样东西**决定：

1. `prompt`
2. `schema`
3. `model`
4. `isolation`（外加 `agentType`，行为一致）

其中任何一个（或 `prompt` 文本）一变，这个调用——以及它之后的一切——都会 live 重跑。
`label` 和 `phase` 是装饰，**绝不**进 cache key。

## Failure 语义（汇总）

| 位置 | 出错时 |
|---|---|
| `agent()` 被用户跳过 | 返回 `null` |
| `parallel()` thunk 抛错 | 对应槽位变 `null`；调用绝不 reject |
| `pipeline()` stage 抛错 | 那个 item 变 `null`；余下的 stage 全跳过 |
| `workflow()` 名字未知 / 读不到 / 嵌套 | **抛错**（catch 来降级） |
| `budget.total` 耗尽后再调 `agent()` | **抛错** |
| `Date.now()` / `Math.random()` / 无参 `new Date()` | **抛错**（determinism 守卫） |

## 硬 caps（见 `mechanism.md` §6）

- 并发：每个 workflow `min(16, cpu cores − 2)`。
- 每次 run 的 agent 总量：1,000。
- 每次 `parallel`/`pipeline` 调用的 item 数：4,096。
- 脚本大小：512 KB。

## `meta`（必需的脚本头）

第一条语句必须是 `export const meta = { ... }`，且是一个**纯字面量**（不含标识符、调用、
模板字面量或 spread）。必填 key：`name`（string）、`description`（string）。
`phases: [{ title }]` 是惯例，它的 title 应当匹配你的 `phase()` / `opts.phase` 字符串。
**以上全部由 harness 强制**——`meta`（纯字面量 + 必填 key）在 launch 时校验；determinism /
caps / escape-hatch 违规在 runtime 抛错。没有独立的 linter——权威的检查就是 runtime。
