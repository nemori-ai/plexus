# 集成可读性盲测 — 发现与修复计划

> 方法:3 个冷启动 agent 黑盒盲测(纯 HTTP、禁读源码、有效 connection-key、不给任何配方),
> 对应现网 hybrid demo(`http://127.0.0.1:7077`)。三个人格:目标驱动 / 评估驱动 / 安全谨慎。
> 触发:用户指出"我用内行知识验证 = 只证明了管道通、没证明可读",要求用盲测度量真实集成体验。

## 三方一致结论(强信号)

| 维度 | 评分 | 一致判断 |
|---|---|---|
| **发现层(前台)** | **9/10** | `GET /.well-known/plexus`(免鉴权)→ `POST /link/handshake` → 富 schema + `how-to-use` skill。**优秀、自描述、令人愉快(~3 次调用就懂了"这是什么、暴露什么")。** |
| **授权核心** | **~2/10** | **黑洞**:拿着有效 key 能发现一切,却**调用不了任何东西**。session→grant→invoke 这一步不可发现、静默失败、错误信息误导。3 个 agent 各浪费 ~6-15 次调用在这一步打转。 |
| **总可读性** | **5–6/10** | 前台满分,授权核心拖垮全局。 |

## 授权核心的具体病灶(目标驱动 agent 深挖出的真 bug)

1. **不可发现**:`.well-known` 的 `auth` 块列了 grants 的 list/refresh/revoke/status,**唯独没有 "创建/申请 grant" 的入口**。`POST /grants` 404,只有 `PUT /grants` 能用——只能靠猜动词。
2. **session 传递不一致(真 bug)**:`GET /grants` 从 **header** `X-Plexus-Session` 读 session;`PUT /grants` 从 **body** `sessionId` 读。用错就 "unknown session"。
3. **静默 no-op(真 bug)**:`PUT /grants` **忽略 grant 条目**,不管什么 body 形状(甚至不存在的 capability id)都返回一个 **匿名空 scope 的 token**(`sub: anon:…, scopes: []`),既不报错也不给 pending。
4. **错误卫生差(真 bug)**:body 形状略错 → **500 Internal Server Error**(未处理崩溃);未知 capability id → **200 空成功**。都该是 `400 + 校验详情`。
5. **从不点名"人工审批"**:没有任何响应/错误/how-to 告诉 agent "去 Plexus 控制台让 owner 批准" + 一个可轮询的 pendingId/approvalUrl。`workspace.write` 的 `grant_required` **不带 pendingId**,文档里承诺的 "PENDS for owner" 流程从没真正触发。
6. **错误词汇诱导越权**:无 grant 状态返回 `grant_required: missing bearer` / `token_revoked` / `signature invalid`——暗示"你需要一个签名 token",把谨慎的 agent 往"去磁盘找签名密钥自锻一个"上推,而不是往"找人批准"上引。(3 个 agent 都识别并拒绝了这个诱惑——但这是**靠 agent 的自律**兜住的,不是结构。)
7. **"读自动授权"的承诺未兑现**:`how-to-use` 说 "reads are auto-granted, no human approval needed",但实际没有任何东西被自动授权。

> 关键复盘:我(内行)之前能跑通,是因为我 handshake 时传了 `agentId`、并走了 owner 的 `PUT /admin/api/grants` 审批路径。冷 agent 不知道这些 → 全部卡死。**我的脚本掩盖了这个根本 bug。用户的判断完全正确。**

## 修复计划(三方 agent 独立推荐的同一个方向)

**北极星:让唯一被"广告"出来的前进路径,就是那条经过审计、owner 批准的正道——消除任何伸手去够签名密钥的理由。**

1. **让正道可发现**:`.well-known` 的 `auth` 块加上 grant-request 入口;`/invoke` 无 grant 时返回**结构化** `{ code: "approval_required", pendingId, approvalUrl, grantStatusUrl, message: "Owner must approve in the Plexus console; the agent cannot mint its own token" }`,而不是裸 `grant_required`。
2. **兑现"读自动授权"**:有效 connection-key session 申请**低敏、first-party 读**能力 → **自动授予**一个 scoped token(key 本身就是信任边界;读自动、写显式)。→ 让冷 agent **无需人工就能读文件**(baseline)。
3. **写/敏感/mesh 走可发现的 pending 流**:申请 → 结构化 pending(pendingId + approvalUrl)→ owner 控制台批准 → agent 轮询 `/grants/status` → 拿 token。
4. **修 session 传递不一致**:统一 `PUT /grants` 与 `GET /grants` 的 session 读取方式(header 或 body 二选一,文档写明)。
5. **修错误卫生**:未知 capability / 畸形 body → `400 + 校验详情`;不再 500 崩溃、不再 200 空成功。
6. **修错误词汇**:无 grant 状态明说"尚无 grant,owner 需批准"并指向审批,而非暗示 token 坏了。

## Baseline 验收(用盲测本身当验收标准)
修完后**再派一个全新的目标驱动冷 agent**(同样纯 HTTP、禁读源码、有效 key),它必须能**无需我帮忙**完成:发现 → 申请读 grant(自动授予)→ invoke `workspace.read` 拿到文件内容;并且遇到 write 时看到**结构化的 pending + 明确的审批指引**。它跑通 = baseline 立住。

## 一个需要你拍板的方向性点
"低敏 first-party 读 = 有效 key 即自动授予(无人工)" 是我按现有 `how-to-use` 的承诺做的默认。若你希望**连读也必须人工批准**(更严),说一声,我把 baseline 改成"读也走 pending 流"。其余修复(可发现、结构化 pending、错误卫生、session 一致)与这个选择无关,都要做。
