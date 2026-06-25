# Contributing to cc-master

Thanks for wanting to make cc-master better. This guide covers the dev loop and
the design invariants you must not break.

> 中文读者：术语保留英文，正文中英混排即可。下面所有命令对中英用户一致。

## Dev setup

cc-master is a Claude Code plugin — no build step, no package install. You run it
straight from a live clone.

```bash
git clone https://github.com/nemori-ai/cc-master.git
cd cc-master
claude --plugin-dir .          # start a local session against the live repo
```

`--plugin-dir` loads the plugin from the working tree with **no cache**, so every
edit you make takes effect on the next session — this is the fastest dogfood loop.
(The marketplace + `enabledPlugins` install path *does* cache; don't use it while
developing — see [README](README.md#install).)

Requirements: **Node 22+** and **bash**. That's it.

## Before you open a PR

Run both checks. They are the same two gates the maintainers run:

```bash
./run-tests.sh                 # hook tests (bash) + content contract (Node 22+)
claude plugin validate .       # validates the plugin manifest, skills, commands
```

`run-tests.sh` must end with `ALL TESTS PASSED`, and `claude plugin validate .`
must report no errors. The harness is the authoritative validator for workflow
scripts — there is intentionally no separate workflow linter to maintain
(see [`skills/authoring-workflows/SKILL.md`](skills/authoring-workflows/SKILL.md) §3).

### 机制 ↔ skill 对账步（改了 command / hook / script 业务逻辑就做）

如果你这次 PR 改动了任何 `commands/` / `hooks/scripts/` / `skills/*/scripts/`（或顶层
`scripts/`）里某个机制的**业务逻辑**（不只是注释 / 排版），开 PR 前做一遍**人工对账仪式**，
确保 skill prose 没和实现脱节（语义漂移）。这是一道**轻量手工核对仪式（ritual），不是自动化
门、也不接 CI**（T30 设计闸定的路线）——所以靠你照着下面三步走：

1. **查矩阵找受影响的 prose**：打开 [`design_docs/mechanism-reconciliation.md`](design_docs/mechanism-reconciliation.md)，
   找到你改的机制那一行，看「被哪些 skill prose 引用」列——这些就是可能描述了你这次改掉的行为的
   prose 文件。

2. **逐一核对 prose 是否仍与改后实现一致**：逐个打开那些文件，确认 prose 对该机制的描述仍与
   on-disk 实现相符。**不一致 = 语义漂移**——按矩阵把 prose 改对（落点就是矩阵列出的那个文件），
   并把该机制行的「上次同步日期」更新到今天。

3. **grep 硬化（堵漏列病根）**：矩阵手维护、可能漏列引用——所以对你改的机制名 `grep skills/`
   一遍，确认矩阵那一行没漏掉任何引用它的 prose 文件。这个 grep 是**一次性核对工具**，不是常驻
   脚本、也不是 lint 门。命令骨架（把 `<机制名>` 换成你改的那个，**优先用去扩展名的 basename**，
   因为 prose 常以不带 `.sh`/`.js` 的形式引用——例如 `verify-board` 而非 `verify-board.sh`）：

   ```bash
   # 例：改了 hooks/scripts/verify-board.sh
   grep -rln verify-board skills/ | grep -v '/scripts/'
   # 把输出和矩阵该行「被哪些 skill prose 引用」列逐一对照：
   #   - grep 命中、矩阵没列  → 矩阵漏列了，补进矩阵那一行
   #   - 矩阵列了、grep 没命中 → 先换不带扩展名的机制名再搜一遍确认；仍无则该引用已失效，从矩阵删
   ```

   口径与矩阵表头一致：`grep -v '/scripts/'` 排除 skill 自身的脚本源码；纯 `DESIGN.md` 的设计性
   提及不算 agent 指导 prose（保留作交叉参考标注即可，不计入引用列）。

If your change is behavioral, also **dogfood it**: start a real orchestration with
`/cc-master:as-master-orchestrator <goal>` and confirm the change works against the
live plugin runtime. Several past bugs were invisible to the test suite and only
surfaced under a real session.

## Design invariants — do not break these

The six load-bearing design red lines (hooks use bash + node/JS — ADR-006 · stable board narrow
waist · two non-overlapping skills · the conductor never plays an instrument ·
ship-anywhere · every hook dormant-until-armed — ADR-007) have a **single source of truth in [`AGENTS.md` §3](AGENTS.md#3-non-negotiable-红线ssot-在此)** —
each with its decision-record link and a PR/CI grep checkpoint. Read it before
opening a PR; a PR that violates one will be sent back.

## Style & conventions

- Match the surrounding prose voice (second-person, direct) in skills and commands.
- Keep `README.md` and `README_zh.md` in sync when you touch user-facing docs.
- Add a `## [Unreleased]` entry to [`CHANGELOG.md`](CHANGELOG.md) for any
  user-visible change.
- Don't commit a real runtime board; `.claude/cc-master/` is gitignored.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For anything security-
sensitive, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
