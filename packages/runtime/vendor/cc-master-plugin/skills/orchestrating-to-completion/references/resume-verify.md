# 续跑 + 端点验收

> **服务愿景：C1**（异步并行 + 完整落地）。**何时读：** 让续跑变便宜 + 让验收可信时——content-hash action key、依赖 pinning / stale 检测、独立的端点验收、loop 收敛、codex 第二验收者。

让续跑变便宜（O(changeset)，而非 O(everything)）、让验收变可信（只在端点验、绝不信 agent 自报）。这是镜头 6——"只信端点验收；输出可记账、可续"——的可操作化。

来源：research report 3（Joiner 的 loop-until-converged）+ report 4（content-addressable cache / end-to-end argument）。

---

## 1. content-hash 续跑 —— build-system 的 action key

把动态 workflow 当成一台**增量构建引擎（incremental build engine）**。每个节点拿到一个 **content-hash** = `hash(spec + upstream outputs + key context)`，这正是 Bazel 的 **action key**。

- **跑之前先查 journal**：hash 命中 → 该节点已经做完 → **复用那个已落地的产物**（commit / PR / output）、**跳过**；miss → 执行，并写一条 journal 条目（带 output ref）。
- **compaction / 中断后的续跑 = O(changeset)**：只重跑那些输入变了、或从未完成的节点（Bazel 式增量构建）。
- **确定性守卫**（应对 AI 的非确定性）：你缓存的**不是**"重跑会产出相同的字节"——而是"一个已落地、且通过了 end-to-end 验收的产物"。验收步骤*本身*就是这份缓存的校验。一旦产物存在、并通过端点检查，该节点就 done、不再重跑。

---

## 2. 依赖 pinning / stale 检测

- **Pin 上游**：每个节点绑定它所消费的上游产物的 version / hash（board 柔性边上的 `dep_pins`）。
- **stale → 重跑**：上游产物一变，就把依赖它的节点标 `stale` 并重跑。这挡住的是"建立在过期快照上、自洽却错误的结果"——节点看着 done，其实是对照一份已经不成立的输入算出来的。

---

## 3. 端点验收 —— 唯一可靠的正确性点

**end-to-end argument**（Saltzer-Reed-Clark, 1984）：一个放在低层的功能，相对于在端点实现它，往往是冗余的；正确性的最终保证必须活在端点。

- **编排者独立验收** —— 它**亲自跑闸**、**亲自读 diff**。低层 agent 那句"所有质量闸都绿"只是一个不可信的性能优化（agent 自报已经一再出错）。
- **gate-green 必要、但不充分** —— 过闸不代表改动正确；你仍然得读 diff。
- **null / 空 review 一律算未通过** —— 一个空的或缺席的 review 绝不是默许放行。这是 silent-pass-through 守卫。
- **靠在真实输入上*跑*来验，不靠纸上读。** 真实缺陷里出人意料地有一大块是 regex / shell / 边界 bug——它们在纸上看着对，只在真实数据或真实环境里才现形——比如一个 `grep -c` 在零匹配时吐出 `"0\n0"`、一条 shell pipe 的环境变量赋值 scope 落到了错误的一侧、一个 frontmatter regex 假设了一行根本不存在的空行。一次 LLM 二审*读*能抓**契约**违背；唯有一次真正的*跑*能抓**运行时**崩溃。两者都做——读 diff **并**对一个真实 fixture 执行闸。

验收是续跑缓存（§1）的校验步骤：唯有一个既存在**又**通过这道端点检查的产物，才算 done。

### resume 第 0 步：先 `cd` 进 `board.git.worktree`，确认 cwd == 它，再接手

`--resume` 唤起的新 session，其 shell cwd **未必** == board 声明的 `git.worktree`——它可能落在 home、上一次操作残留的某目录、或另一个 checkout 里。**接手的第一件事**（先于 reconcile、先于任何孤儿验收、先于跑任何闸）：读 board 窄腰里的 `git.worktree`，`cd` 进去，**核对 cwd 确实 == 它**（`pwd` 比对，或 `git -C` 显式锚定每条命令）。确认一致前不要执行任何后续动作。

为什么这是第 0 步而非「顺手」：resume 之后你做的每件事都隐式依赖 cwd——相对路径读写、`git status` / `git diff` / `git log`、端点验收的 `bash run-tests.sh` 与 `claude plugin validate .`、重派 sub-agent 给的工作目录。cwd ≠ worktree 时这些**全在错的地方跑**，而且是**静默错误**，两种后果都致命：

- **挂掉**——命令在错目录找不到文件（`run-tests.sh: No such file`），还算好，至少炸得见。
- **静默跑错树**（更阴险）——cwd 下恰好有另一个 checkout / 另一份产物，闸照样跑、照样绿，你把一个**根本不是 board 目标**的产物标成 `done`/`verified`。端点验收的全部可信度（镜头 6）建立在「验的是对的那棵树」之上；cwd 漂了，gate-green 连必要条件都不是。pressure baseline 实证：强模型在三压下默认信任 ambient cwd、直奔验收，跑绿纯靠运气恰好身处对的 repo，且**跑完闸才**注意到 board 的 `branch` 与实际不符——顺序正好反了。

确认 cwd == worktree 后，顺带核对当前分支 == `git.branch`（窄腰里有）；不符是「这块板的执行环境与我所处环境漂移」的信号，停下来对账，绝不在错分支上接续 / 验收 / 发版。

### 孤儿 `in_flight` 续接（新 session 接管旧板时）

`--resume` 把一块**已存在**的 board 盖成本 session 后（跨 session re-arm，见 ADR-009），上一段 orchestration 派发的后台任务的 **handle 活在那个已不在的旧 session 里**——新 session **attach 不回这些 handle**，那些后台进程可能早随旧 session 死了，也可能还在跑但你无从收割。board 上它们是 `status:"in_flight"` + 一个**已失效的 handle**。这是 resume 最微妙的正确性点——但它**不引入新机制**，只是把这个触发场景接进上面已有的 §1 content-hash 续跑 + §3 端点验收 + status enum 的 `stale`/`ready` 路由：

- **旧 handle 一律当作【失效】**——绝不用它去查 / 收割后台输出（attach 不上）。
- **走端点验收判它到底有没有真做完**：算该节点的 content-hash（§1：`spec + 上游产物 + key context`），查产物是否已落地（commit / PR / 文件已存在）。
  - 产物**存在且通过端点验收**（§3：亲跑闸 + 读 diff，不信任何自报）→ 标 `done`/`verified`。这正是 §1 的 content-hash 续跑：产物在且验过 = 不重跑（O(changeset)）。
  - 产物**不存在 / 验收不过** → 该 `in_flight` 是孤儿、未完成：降回 `ready`（或 `stale`，若它依赖的上游产物也可能变了，见 §2），**重新派发**拿到一个写回 board 的**新 handle**。
- **绝不把旧 `in_flight` 当作「还在飞、继续等」**——旧 handle 已死，干等 = idle-wait 空等（七镜头第 4 的反模式）。在端点【验或重派】，二选一，不留薛定谔的 `in_flight`。

### codex 作为一个独立的第二端点验收者

`${CLAUDE_SKILL_DIR}/scripts/codex-review.sh` 跑 `codex exec review --base <branch> --json`（review-only、只读 sandbox），并按 openai-codex 插件的 `review-output.schema.json` 吐出一个 `verdict`（`approve | needs-attention`，每条 finding 携带 severity/file/line/confidence）。这个 verdict 直接映射到 §4 的 Joiner 闸：

- `needs-attention` → **`Replan(feedback)`** —— 把 finding 当成那条带诊断的 replan 信号；修了再验。
- `approve` **且** review 非空 **且** diff 确实读过 → **`FinalResponse`**（done）。
- 空 review / 调用失败（`exit 2`、`CODEX_REVIEW_FAILED`）→ **未通过** —— silent-pass-through 守卫（§3）；绝不默许放行、绝不 done。

这与编排者自己的端点检查是同一条红线：只信端点验收、gate-green ≠ passed、agent 自报不可信。codex 是一个*第二*端点读者，不是跑闸的替代品——你照样读 diff、照样跑闸；codex 负责抓那次跑抓不到的契约违背。

---

## 4. Loop 收敛 —— 结构化闸 + 保险丝 + dedup

当一个节点的执行图取决于事先未知的中间结果（分支）时，就 loop 到收敛为止——Joiner 模式：

- **结构化闸**：一个结构化的二选一——`FinalResponse`（收敛 → 收工）vs `Replan(feedback)`（带上对先前尝试的诊断 + 要修什么 → 重编一张新 DAG → 重新调度）。这个决策按**类型**做，绝不凭一个模糊 / 空的判断——它和"一个 null review = 未通过"是同一套结构性防御。
- **`Replan.feedback` 是关键设计** —— 它不是盲目 retry，而是一个**带诊断的 replan 信号**（这正是 impl → review → verify → amender 的内层 loop：verify 闸 ≈ Joiner，amender feedback ≈ `Replan.feedback`）。
- **max-rounds 保险丝** —— 每个内层 loop 都必须有保险丝（打到轮数 / 调用上限就停）。没有 loop 可以无界地跑。
- **dedup-against-seen** —— 把已否决的项目记下来，免得一个被否的选项每一轮又重新冒出来。
