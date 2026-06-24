# 交接给新 session（handoff —— 写侧）

> **服务愿景：C1**（异步并行 + 完整落地）**· C3**（自主决策 vs 人类接入边界）。**何时读：** 当前 session 要把一场 orchestration 优雅交给一个新 session 时——quiesce / drain（+ straggler 兜底）/ 写一份叙事层 handoff 文档 / 归档换无摩擦 resume。这是**写侧**（旧 session 写交接）；它的**读侧**——新 session 用 `--resume` 接手、reconcile 孤儿 `in_flight`——在 `resume-verify.md` §3，本文交叉引用、绝不复述。

一场长跑 orchestration 不总能在一个 session 里跑完——context 快耗尽、要跨机器、或人为切场。`handoff-to-new-session` 命令让**当前正在跑**的 orchestrator 把 board 干净地交给一个**新 session**（新 session 随后 `--resume` 接手）。本文是这次交接的方法论：什么时候停手、怎么把在飞任务排空、交接文档该装什么不该装什么、为什么归档反而让 resume 更顺。

## 目录

- [交接的 6 步](#交接的-6-步)
- [drain 纪律 + straggler 兜底](#drain-纪律--straggler-兜底)
- [叙事层 / 无噪声纪律（judgment-bearing）](#叙事层--无噪声纪律judgment-bearing)
- [6 段文档模板](#6-段文档模板)
- [归档换无摩擦 resume 的 rationale](#归档换无摩擦-resume-的-rationale)
- [Rationalization Table](#rationalization-table)
- [Red Flags](#red-flags)

---

## 交接的 6 步

命令体（`handoff-to-new-session.md`）给的是逐步落地；这里只钉每步的**为什么**与纪律边界：

1. **Quiesce** —— 立刻停止派发新活（本回合起不再有新任务进 WIP）。已在飞的让它跑，只是不再开新的——因为你正要离场，开新活就是给新 session 多留一个盲验的孤儿。
2. **Drain** —— 让在飞任务在**当前** session 跑完、每个落地即就地端点验收。当前 session 还握着 live handle，验起来比新 session 盲验省（详见下「drain 纪律」）。
3. **Write** —— 写一份**叙事层** handoff 文档（详见下「叙事层纪律」+「6 段模板」）。
4. **Log** —— board 柔性边 `log` 段追加一条指向 handoff 文档路径的指针 + 一行最终态；bump `owner.heartbeat`。只动柔性边，绝不碰硬 narrow-waist 字段（见 `board.md`）。
5. **Archive** —— 置 `owner.active:false`（同 `/stop`），让新 session 的 `--resume` 走无摩擦路径（详见下「归档换无摩擦 resume」）。
6. **告诉用户** —— handoff 文档路径 + 新 session 要跑的确切 `--resume <选择器>` 命令。

---

## drain 纪律 + straggler 兜底

**为什么在当前 session drain，而不是把一切甩给新 session：** 你现在还握着每个在飞任务的 **live handle**——能直接收割后台输出、就地端点验收。一旦切到新 session，那些 handle 活在已死的旧 session 里、attach 不回（孤儿 `in_flight`，读侧处理见 `resume-verify.md` §3）。所以凡能在当前 session 排空、验完的，就别留给新 session 当孤儿盲验——**当前 session drain 是更省的那条路**。

- **drain 的 happy path**：在飞任务逐个收敛，每个落地即就地端点验收（亲跑闸 + 读 diff，见 `resume-verify.md` §3——不信任何 agent 自报），标 `done`/`verified`。收敛后多半只剩一份干净的 board 可交。
- **straggler 兜底**：某个**真长跑**的在飞任务在一个合理收敛窗口内排不空时——别让收敛把「切 session」无限期焊死。把**这一个**降级成「孤儿 + 重验指引」（在 handoff 文档第 3 段写清产物落点 + 怎么端点验 + content-hash 提示，链到 `resume-verify.md` §3），并 **surface 给用户**：等它跑完再交、还是现在当孤儿交出去。这是一个 `blocked_on:"user"` 形态的抉择——抛给用户，别擅自焊死任一边。
- **纪律边界**：straggler 兜底是**针对单个长跑任务的逃生口**，不是「整批在飞都不验、全甩成孤儿」的许可证。能在合理窗口内排空的就排空、就验——只有真排不空的那一个才降级。把可 drain 的整批甩成孤儿，是把端点验收的活推给一个 handle 已死、验起来更贵的新 session（反 drain 的全部意义）。

---

## 叙事层 / 无噪声纪律（judgment-bearing）

**board 本就承载结构化状态**——DAG、每个 task 的 status/deps/artifact/handle、log。新 session `--resume` 会原样读到它。所以交接文档的价值，**恰恰是 board 装不下的那些东西**：你试过又放弃了什么、为什么这么决策、坑埋在哪、临界路径心算落在哪条链、下一步该往哪使劲。**噪声 = 复述 board。** 文档纯叙事层、指向 board。

判据——一段内容该不该进 handoff 文档，问它**这东西 board 里有没有**：

- **board 装不下 → 进文档**：负向结果（试过的死路 + 为什么死，board 只记 task `done`/`ready`，不记「这条路走过、断在哪」）、决策理由、gotcha、临界路径的**综合判断**（board 有原始 deps/status，没有「杠杆在哪条链」这个结论）、悬而未决的用户决策的上下文。
- **board 已装下 → 指向它，绝不复抄**：DAG 本身、per-task 的 status/deps/handle/artifact 清单、log。这些 `--resume` 一读就有，复抄进文档只是造了**第二份会过期的真相**。

**为什么这条要写死（而不是「凭直觉，多写点总没坏处」）：** 切 session 时你正累、context 快耗尽、且怕丢掉攒了一身的 mental context——这三股劲叠起来，会把「为稳妥起见，把整个 board 都 dump 进去 / 再用英文把每个 task 的 status 走一遍，新 session 看着省事」变成一个**感觉负责任**的念头。它感觉像 belt-and-suspenders，实则是反的：

- **两份真相 = 必然漂移**。board 是活的——一个后台 handle 跑完、下游 task 解锁、status 流动。你 dump 进文档的那份快照冻结在交接那一刻；新 session 一动手，board 是对的、你那段是过期的谎，且它**读起来像权威**（一段英文 task 走查，读者分不清该信哪份）。一份和 live board 打架的 handoff 文档，比没有这段还糟。
- **它甚至不更快**。新 session 是用 cc-master 自己的机制读 board，不是手 parse JSON——你拿「省得它 parse JSON」当理由，省的是一笔根本不存在的成本，换来的是维护负担 + 漂移风险。
- **「英文写的就是叙事」是伪装**。一段 prose 形态的 per-task status 走查，**形态是 prose，本质是 board `tasks[]` 的英文转写**——它是噪声，不因为写成了句子就变叙事。叙事 carries 的是 board **装不下**的（why / 死路 / 综合判断），不是 board 内容的 fuzzy 副本。

**最隐蔽的一档是「折中」**：「那我只把临界路径附近那 5 个 task 的 status 用 prose 走一遍，不全 dump」——这不是第三条路，是上面那条错的**穿了件小一号的衣服**。它保留的正是错的那一类内容（live state 的冻结副本），只是少一点；而临界路径「该往哪推」的那个**结论**，本就该由叙事层第 6 段的一行综合判断 carry（「临界路径走 T1→T9→T12，推这里」），不靠复述那 5 个 task 的 status。砍到 5 个不解决漂移，只是把会误导人的那份做小。

---

## 6 段文档模板

交接文档是决策程序 step-6 ledger 的**更丰富的近亲**（step-6 ledger 的固定形态见 `async-hitl.md` §「step-6 ledger」——那是每条未关闭路径一行 + 一行裁决的精炼自检；交接文档在它之上补足 board 装不下的叙事）。照下面 6 段写，**显式 NOT 包含**全量 DAG / task 列表 / status（指向 board 即可）：

```markdown
# Handoff: <goal 一句话>

**Board**: <配对的 board 文件完整路径>
**Handed off by**: session <旧 session_id>, at <UTC 时间戳>
**New session, start here**: 跑 `/cc-master:as-master-orchestrator --resume <选择器>`，
然后读本文件。结构化状态（DAG / 每个 task 的 status·deps·handle / log）全在上面那块
board 里——`--resume` 会原样读到，本文件不复述它，只补 board 装不下的。

## 1. 当前态势（一句话）
交到哪了、整体健康度。例：「14 个 task，9 done+verified，1 个 straggler 孤儿
（见 §3），其余 ready/blocked——临界路径见 §6。」

## 2. 在飞孤儿 + 重验指引
（收敛后 happy path 多半为空；只剩 drain 兜底降级的 straggler。）
逐个：产物落在哪、怎么端点验（亲跑哪道闸 + 读哪段 diff）、content-hash 提示。
→ 怎么 reconcile 一个孤儿 `in_flight`（旧 handle 一律当失效、走端点验或重派）见
`resume-verify.md` §3，本节不复述那套路由。

## 3. 关键判断 / 上下文（board 装不下的）
试过又放弃了什么、为什么这么决策、坑在哪。
例：「T4 的 i18n key 抽取先试了 AST-walker，它漏 template-literal 插值、耗了 2h，
已换 runtime extraction——别回头走 AST 那条路。」

## 4. 悬而未决的用户决策（blocked_on:user）
每条附上下文，别让新 session 重新挖。
例：「D1：PR 要不要拆成两个？已问用户，未答——拆点见 board T11/T12 的边界。」

## 5. 下一步往哪使劲
临界路径心算 + 建议首动作（结论，不是数据）。
例：「临界路径走 T1→T9→T12，杠杆在这条链；首动作派 T4 的 runtime-extraction 重试
（当前唯一 ready 且解锁下游的）。」
```

（段 2 在 happy path 常为空、可只留一句「无在飞孤儿，board 全部 done/verified 或 ready」。）

---

## 归档换无摩擦 resume 的 rationale

交接的最后一步是把 board **归档**（`owner.active:false`，同 `/stop` 机制）。这看着反直觉——「我在交接，为什么要停用它」——但它正是让新 session 接手最顺的那一步：

- **归档板的 `--resume` 走无摩擦路径**：`as-master-orchestrator --resume` 对一块 `owner.active:false` 的归档板**无需 `--force-takeover`**——直接复活（`false → true` + 重盖 `owner.session_id`），因为归档是「这块板当前没有活 owner」的显式信号，不存在跨 session 抢占活 owner 的风险（ADR-009 的「复活归档板」无摩擦路径）。反之，若你把板留成 `owner.active:true` 就切走，新 session resume 会撞上「这板看着仍有活 session」的接管安全闸（heartbeat + mtime 探测），要 `--force-takeover` 二次确认——平白给交接加一道摩擦。
- **归档是显式可逆，不是删除**：board 文件保留，`tasks`/`log`/`goal`/`git` 全留——归档只把 `owner.active` 翻成 `false`。新 session `--resume` 把它翻回 `true` 即满血复活。这也是 §1 第 4 步「log 留指针」要先于归档的原因：归档前把指向 handoff 文档的指针落进 board.log，新 session resume 读 board 时一眼看到「去读那份 handoff」。

---

## Rationalization Table

切 session 时（累 + context 快耗尽 + 怕丢 mental context）最易成形的几条借口，与真相：

| 借口（切 session 时会对自己说的话） | 真相 |
|---|---|
| 「我不在了没法答问，**为稳妥把整个 board 也 dump 进 handoff**，belt-and-suspenders。」 | 那是造**第二份会过期的真相**，不是稳妥。board 是活的、你 dump 的是冻结快照；新 session 一动手，board 对、你那段成了读起来像权威的谎。一份和 live board 打架的文档比没有还糟。指向 board，别复抄。 |
| 「**再用英文把每个 task 的 status 走一遍**，新 session 看着省事、不用 parse JSON。」 | 「省得 parse JSON」省的是一笔不存在的成本——新 session 用 cc-master 机制读 board，不手 parse。一段 prose 形态的 per-task status 走查，**形态是叙事、本质是 board `tasks[]` 的英文转写**，是噪声。叙事 carries 的是 board 装不下的（why / 死路 / 综合判断）。 |
| 「**那我只走临界路径那 5 个 task 的 status**，折中，不全 dump。」 | 折中是错答案穿了件小一号的衣服——它保留的正是错的那类内容（live state 的冻结副本），只是少一点。「该往哪推」的结论本就由第 5 段一行综合判断 carry，不靠复述那 5 个 status。砍到 5 个不解决漂移。 |
| 「这个在飞任务还在跑，**整批先不验、全当孤儿甩给新 session**，我好早点收。」 | 那是把端点验收推给一个 **handle 已死、验起来更贵**的新 session（反 drain 的全部意义）。straggler 兜底只对**真排不空的那一个**降级；能在合理窗口内 drain+验的整批，必须当前 session 验完。 |

---

## Red Flags —— 停，你在往 handoff 文档里塞噪声 / 跳过 drain

- 你正要把 board 的 DAG / task 列表 / 全量 status 复制进 handoff 文档（造第二份会过期的真相）。
- 你正要「用英文把每个 task 的 status 走一遍」——哪怕只是临界路径那几个（prose 形态的 board 转写仍是噪声）。
- 你以「我不在了没法答问」为由往文档里加 board **已经装下**的东西（该加的是 board 装不下的 why / 死路 / 综合判断，不是 board 内容的副本）。
- 你正要把一整批**能在当前 session drain+验**的在飞任务全甩成孤儿，只为早点切走（straggler 兜底只对真排不空的单个任务）。
- 你正要留着 `owner.active:true` 就切走（给新 session resume 平白加一道 `--force-takeover` 摩擦——归档它）。
- 你正在为「*这次*交接特殊，多 dump 点 board 内容总没坏处」构建论证——那套论证本身就是症状。

> **违背字面就是违背精神。** handoff 文档的纪律是「叙事层 carries board 装不下的，绝不复抄 board 已装下的」——当你开始论证「这段 status 走查写成了英文所以算叙事」，那正是噪声穿叙事外衣的那一刻。
