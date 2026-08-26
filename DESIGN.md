# dsh 插件设计文档:`dsh-peak-shift`(错峰省费)

> 目标:在 DeepSeek Harness(dsh,`@deepseek-ai/dsh` v0.1.1-rc.2)中,把长任务的 LLM 请求从「高峰时段」推迟到「低谷时段」执行,利用错峰计价与避开拥堵节省 tokens 费用。
>
> 本文基于本机安装的 dsh 源码精读(`$APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`),所有 API 均来自实际安装版本。

---

## 1. 调研结论(设计依据)

### 1.1 dsh 插件体系(已确认)

- dsh 是 **Cordis 插件框架**的宿主:profile = 多个插件 bundle + patch 层叠加。插件 = 一个 npm 包,导出 `{ name, Config, inject, apply }`(函数插件)或 Service 类;由 `@deepseek-ai/cordis-plugin-loader` 动态 import 并 `ctx.plugin()` 启动。
- 挂载方式两种:
  1. **bundle**:包 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,`dsh plugin --profile web add <pkg>` 后自动进入 `dsh.profile.bundles`;
  2. **patch 行**:在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中 `insert` 一行 `{ id, name, config }`(本机 web profile 已存在该文件,当前为 `[]`)。
- 生命周期:插件的 `ctx.on(...)`、`ctx.effect(...)`、`ctx.provide(...)` 全部随 fiber dispose 自动清理;`ctx.timer` 提供随 fiber 释放的 `timeout/interval`。

### 1.2 长任务如何执行(已确认)

- 主循环 `ReactLoopAgent`: `kick() → while(await turn()) → while(step) → 模型请求/工具循环`;每次模型请求前都会走 **`agent/pre-step` 瀑布**。
- **目标驱动长任务**:`dsh-goal` 提供事件溯源的服务 `ctx.goals`;`dsh-goal-round-driver` 在 agent idle 时不断 `agent.followup()` 下一 Goal Round,形成「多轮无人值守长任务」。
- 后台任务 jobs/workflow/headless **都没有 pause/resume**,只有 cancel/wait。

### 1.3 可复用的「暂停」原语(设计核心)

| 原语 | 位置 | 语义 | 用于 |
|---|---|---|---|
| `agent/pre-step`(waterfall) | `dsh-agent` 事件 | 调用 `next()` 放行;**不调用 `next()` = 拦截本次请求**;payload 带 `{ agent, messages, turn, step, signal }` | **通用请求闸门**(核心) |
| `agent.cancel(cause, { keepInbox: true })` | `dsh-agent` | 中止当前 turn,保留排队消息;未分发的工具调用写合成结果 | 可选(仅 `enforcement: 'cancel'`)的立即停车;默认不用,以免打断在途请求 |
| `ctx.goals.pause(agent, ref)` / `ctx.goals.resume(agent, ref)` | `dsh-goal` | 持久化 `active→paused→active`,配合 round-driver 自动停/续轮 | **长任务的官方暂停/恢复**(核心) |
| `agent.steer(msg)` / `agent.send(msg, 'next-step', true)` | `dsh-agent` | 唤醒 driver 并投递消息 | 恢复被拦请求 |
| `ctx.sessions.flush(session)` | `dsh-session` | 持久化检查点屏障 | 暂停/恢复前落盘 |
| `session.append(type, data)` + `SessionEventMap` 声明合并 | `dsh-session` | 追加持久事件,可被 fold 重放 | 插件自有的持久化(仿 `dsh-schedule`) |

### 1.4 计量现状(已确认)

- **dsh 没有任何「费用」计量**:只有 token 数(`assistant/message.usage` / `assistant/chunk` 的 `TokenUsage`: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}`)。
- `dsh-llm-deepseek` 的模型目录**没有** price/peak/offpeak 字段;官方错峰折扣需要插件自带价格模型。
- DeepSeek 历史公开错峰折扣(V3):低谷时段(北京时 00:30–08:30)缓存未命中价约 5 折。V4 需以官方为准 → **窗口与价格做成可配置**。

---

## 2. 功能设计

### 2.1 核心能力

1. **高峰暂停(自动)**:进入高峰窗口时,暂停所有「长任务」agent:
   - 若有 active goal → `agent.cancel(hook, {keepInbox:true})` + `ctx.goals.pause()`(持久化),round-driver 停止续轮;
   - 若无 goal 但命中 `targets` → 用 `agent/pre-step` 闸门拦截后续所有 LLM 请求。
2. **低谷续跑(自动)**:到达低谷起点时:
   - `ctx.goals.resume()` → round-driver 自动续下一轮;
   - 恢复被拦截的请求(见 §4.4)。
3. **费用估算**:统计「被错峰到低谷的请求实际 token 用量」×「高峰−低谷单价差」,给出累计节省额(估算,非账单)。
4. **手动控制**:模型可用 `peak_shift_pause` / `peak_shift_resume` / `peak_shift_status`;可覆盖自动窗口。
5. **可观测**:会话内状态(`paused / waiting / resuming / active`)、下次窗口切换时间、已节省金额。

### 2.2 配置项(schemastery schema)

```yaml
# cordis.patch.yml 中的 config
config:
  # 目标:哪些 agent 参与错峰
  targets: [goal]            # goal | headless | subagent | interactive(默认仅 goal)
  # 窗口定义(时区 + 每周高峰段);低谷 = 其余时间。
  # 默认按 DeepSeek 官方计价规则:高峰 = 北京时 周一至周五 09:00-12:00、14:00-18:00;
  # 其余时间(含周末)均为空闲时段。
  windows:
    zone: Asia/Shanghai      # IANA 时区,窗口按本地钟判定
    peak:
      - days: [mon, tue, wed, thu, fri]   # 支持 1~7 个星期几;空 = 每天
        ranges: ["09:00-12:00", "14:00-18:00"]
  leadMinutes: 5             # 高峰前提前启动闸门,避免高峰边界上仍有在途请求
  enforcement: gate          # gate(默认,只拦新请求、不打断在途)| cancel(到点中止在途 turn)
  mode: park                 # park(持久化停车) | defer(进程内挂起) | off(仅记录)
  # 价格模型(dsh 无价格表,插件自带;用于节省额估算)
  pricing:
    currency: USD
    perMillion:
      input: 0.27            # 未缓存输入(按官方实际价填写)
      cacheRead: 0.07
      cacheWrite: 1.07
      output: 1.10
    peakFactor: 1.0          # 高峰价 = base × peakFactor
    offPeakFactor: 0.5       # 官方规则:空闲时段价格 = 高峰价格的一半
  startPolicy: park          # 高峰中新建的长任务:park(等低谷)| run(照跑)
  statsEvent: true           # 是否把累计节省写进 session 日志
```

### 2.3 模型可见工具(注册到 `agent.ctx.tools`,仿 `dsh-schedule`)

| 工具 | 参数 | 返回 |
|---|---|---|
| `peak_shift_status` | — | 当前窗口、agent 暂停状态、下次切换 UTC 时间、已节省金额与次数 |
| `peak_shift_pause` | `reason?` | `{ agentId, state: 'paused' }`(手动暂停该 agent) |
| `peak_shift_resume` | — | `{ agentId, state: 'active' }`(手动恢复) |
| `peak_shift_stats` | — | 本轮错峰的 token 明细与节省估算 |

用户侧提供 `/peak-shift` 斜杠命令(仿 `command-goal`),可查看/开关。

---

## 3. 架构设计

### 3.1 插件形态与挂载

- **形态**:函数插件 + 可选的 bundle patch;`inject = ['agents', 'sessions', 'tools', 'sessionPersistence', 'timer']`;`goals` **不作为静态依赖**(用 `ctx.get('goals')` 惰性读取),使插件在无 goal 的最小组合里仍可用。
- **挂载**:
  ```yaml
  # $DSH_HOME/profiles/web/cordis.patch.yml
  - insert:
      - id: peak-shift
        name: '@your-scope/dsh-peak-shift'
        config: { ... }
  ```
  或做成 bundle:`dsh plugin --profile web add @your-scope/dsh-peak-shift`。

### 3.2 模块划分

```
dsh-peak-shift/
├── package.json            # 若为 bundle: "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml        # insert 行
└── lib/
    ├── index.js            # apply(ctx, config):装配
    ├── windows.js          # 窗口判定/下次切换计算(Intl 时区)
    ├── runtime.js          # 每 agent runtime(仿 dsh-schedule):定时、状态、恢复
    ├── domain.js           # peak-shift/pause · resume 事件 编码/解码/fold
    ├── gating.js           # agent/pre-step 闸门(拦截/挂起/恢复)
    ├── goal.js             # ctx.goals 的 pause/resume 封装
    ├── stats.js            # 节省额估算(fold 会话日志)
    └── tools.js            # peak_shift_* 工具
```

### 3.3 状态机(每 agent)

```
active ──(进入高峰窗口 / lead 到点)──▶ pausing ──(cancel+goals.pause / pre-step 拦截)──▶ paused
paused ──(低谷起点 / 手动 resume)──▶ resuming ──(goals.resume / 恢复被拦请求)──▶ active
paused ──(用户取消 / 会话结束)──▶ released(释放排队,不续跑)
active ──(targets 不含该 agent)──▶ exempt
```

持久状态(held 消息、累计统计、暂停态)记录在 **sidecar 文件** `$DSH_HOME/peak-shift/<sessionId>.json`(原子写入),冷会话 resume 时读回;goal 的 phase/revision 由 `dsh-goal` 自身的 `goal/change` 事件持久化。**不用自定义 session 事件** —— 原因见 §6。

### 3.4 关键实现路径

#### 高峰暂停(窗口入口,`ctx.timer` 到点)

```ts
function enterPeak(ctx, agent, runtime) {
  if (!shouldPause(agent)) return;
  // 1) 有 goal → 停 driver(disarm),round-driver 不再续新轮。
  //    注意:park 模式必须做这一步,否则 driver 会在 agent idle 后不断 followup 新轮,
  //    与闸门形成「followup→拦截→blocked→再 followup」的日志膨胀循环。
  const goals = ctx.get('goals');
  const goal = goals?.get(agent);
  if (goal?.phase === 'active') {
    goals.pause(agent, { id: goal.id, revision: goal.revision }); // active→paused(持久化)
  }
  // 2) 仅当 enforcement='cancel' 时才立即中止在途 turn:
  //    会浪费已流式输出(记 interrupted:true,照常计费)并把未分发工具调用记为 ABORTED,
  //    与省费目标相悖,因此默认关闭。
  if (config.enforcement === 'cancel') {
    agent.cancel({ kind: 'hook', reason: 'peak-shift' }, { keepInbox: true });
  }
  // 3) 置暂停态:在途请求自然排空,后续新请求在 pre-step 闸门被拦,不会被硬打断。
  runtime.setState('paused');
  await ctx.sessions.flush(agent.session);                         // 落盘检查点
  runtime.scheduleResume();                                        // 定时到低谷起点
}
```

#### 低谷续跑

```ts
function enterOffPeak(ctx, agent, runtime) {
  const goals = ctx.get('goals');
  const goal = goals?.get(agent);
  if (goal?.phase === 'paused') {
    goals.resume(agent, { id: goal.id, revision: goal.revision }); // paused→active(armed)
    // round-driver 监听 goal/changed 自动 followup 下一轮
  }
  runtime.resumeHeldMessages(agent);                               // 见下
  runtime.setState('active');
}
```

#### 请求闸门(`agent/pre-step`,waterfall,prepend)

```ts
ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
  if (!runtime.isPaused(agent)) return next();            // 非暂停直接放行
  switch (mode) {
    case 'defer':                                          // 挂起:等到低谷或取消
      await waitUntil(signal, () => runtime.resumeAt() <= Date.now());
      return signal.aborted ? { kind: 'reject' } : next(); // 原批消息原样继续
    case 'park':                                           // 停车:拦下并持久化
      runtime.park(messages);                              // 持久化到 sidecar(见 §6,非 session 日志)
      return { kind: 'reject' };                           // turn 以 blocked 收尾,消息由我们保存
  }
});
```

- **defer 模式**:不丢消息、精确续步;agent 在暂停期保持 running(挂起在瀑布上);信号 abort 时退出。
- **park 模式**:持久、可跨进程恢复;恢复时对每条 held message 调 `agent.steer(msg)`(唤醒 driver,保留原 id/source)。此模式会与 `dsh-goal-round-driver` 的 pre-step 保留竞态,因此 **park 总是先 `goals.pause`**(见 3.4 高峰暂停),并监听 `turn/end blocked` 释放竞态。

#### 在途请求会不会被打断

- **新请求(尚未发出)**:在 `agent/pre-step` 被拦,`next()` 未被调用 → 请求根本不会发出,零成本、无打断。这是「停车」的主体。
- **在途请求(高峰开始时正在流式返回)**:默认 `enforcement: 'gate'` **不打断**,让它自然排空;下一个步骤的请求才会被闸门拦下。`leadMinutes` 提前启动闸门,进一步保证高峰边界上没有在途请求。
- **只有 `enforcement: 'cancel'` 才会硬打断**:经 `agent.cancel(keepInbox)` 中止在途 turn,已流式输出记为 `assistant/message { interrupted: true }`(照常计费),未分发工具调用记为 `ABORTED_BEFORE_DISPATCH`,会浪费已消耗 tokens,默认关闭。
- **闸门自身的挂起**(`defer` 等待低谷)可被 turn 的 `signal.abort`(用户取消/父级取消/会话销毁)随时安全打断并退出。

### 3.5 节省额估算(stats)

- 数据源:会话日志 `assistant/message.usage`(真实 token 计数)。
- 做法:fold 日志,把「pause 后被拦、在低谷实际跑掉的步骤」的 token 用量 × `(peakFactor − offPeakFactor)` × 单价,累计为 `savedEstimate`;同时统计「被错峰的请求数 / 步数」。
- 按官方规则(`offPeakFactor = 0.5`):每错峰 1 个请求,节省其按高峰价计费的 50%(即 `tokens × base单价 × 0.5`)。
- 输出:`peak_shift_stats` / `peak_shift_status`;累计值随 sidecar 持久化。
- 诚实标注:这是**估算**,不是 DeepSeek 账单;价格表可由用户按实际扣费校准。

### 3.6 边界与失败模式

| 场景 | 处理 |
|---|---|
| 系统时间跳变 | 每次 wake 重读墙钟(仿 `dsh-schedule`),按「当前是否在窗口内」重新决策 |
| DST 切换 | 窗口按 `Intl.DateTimeFormat`(zone)取本地钟判定,自动跟随 |
| 进程重启/冷会话恢复 | sidecar 读回 held 消息与累计统计;goal phase/revision 持久,`agent/session-start` 时按当前窗口重新 `_enterPause`/`goals.resume` |
| 用户取消/手动干预 | 监听 `agent/cancel`/`turn/end` 释放 park 的 held messages;`peak_shift_resume` 置手动覆盖 |
| 高峰跨天 | 窗口段支持多段;`scheduleResume` 计算最近的低谷起点(≤24h,timer 单段足够) |
| 无 goal 的最小组合 | `goals` 惰性读取,缺席时只做 pre-step 闸门 |
| 长任务无 LLM 请求(纯工具循环) | 闸门不产生额外成本;仅 `enforcement: 'cancel'` 时窗口入口的 cancel 会以合成结果收尾未分发工具调用 |

---

## 4. 参考的类似插件/模式

| 来源 | 借鉴点 |
|---|---|
| `@deepseek-ai/dsh-schedule` | 「每 agent 一个 runtime + session 事件日志持久化 + 定时唤醒 + 严格 fold」的整体范式 |
| `@deepseek-ai/dsh-time-context` | `agent/pre-step` 的 prepend 监听写法;`next()` 下游决策的调用约定 |
| `@deepseek-ai/dsh-goal` + `dsh-goal-round-driver` | **官方「长任务暂停/恢复」语义**(`pause`/`resume` 动词 + armed/disarmed),是本插件的首选停车原语 |
| `@deepseek-ai/dsh-tool-subagent-control` | `interrupt_agent` 的 `cancel(…, { keepInbox: true })` 用法(只停当前 turn 保留排队) |
| `@deepseek-ai/dsh-llm-retry` | 「现在不发请求、延后重发」的时序控制(`Retry-After`/退避)思想 |
| `@deepseek-ai/dsh-jobs`/`dsh-tool-jobs` | 后台任务的 owner 隔离与完成通知投递(`inject`/`followup`) |
| 框架层 `cordis`/`cordis-plugin-timer`/loader | 插件生命周期、`ctx.timer`、bundle patch 挂载 |

---

## 5. 里程碑建议

1. **M0 骨架**:函数插件 + `cordis.patch.yml` 挂载到 web profile;`windows.js` 窗口判定 + `peak_shift_status` 工具。
2. **M1 defer 闸门**:`agent/pre-step` 挂起/放行 + `ctx.timer` 低谷唤醒;目标限定 goal agent。
3. **M2 park 持久化**:`peak-shift/pause|resume` 事件 + fold + `goals.pause/resume` 闭环;`startPolicy`、`leadMinutes`。
4. **M3 计量**:stats fold + 价格表 + `peak_shift_stats`;`/peak-shift` 命令。
5. **M4 打磨**:多窗口段、DST、手动覆盖、冷恢复、invariant 伴生插件(仿各包 `./invariant`)。

> 说明:DeepSeek 官方错峰折扣窗口与折扣率会随模型/时间变化,插件价格与窗口默认值应集中、可配置,并在上线前以官方定价页核实。

---

## 6. 实现落地与设计差异

完整实现位于 **`c:\Python projects\dsh-peak-shift\`**(bundle 插件,`dsh plugin --profile web add ./dsh-peak-shift` 安装)。与本文前面设计相比,落地时修正/明确了两点:

### 6.1 持久化从「session 自定义事件」改为「sidecar 文件」

实现前核实的硬约束:
- `Session.append(type, data)` **不接受** `ignorable: true` 参数;
- 持久化读取路径(`dsh-session-persistence` 的 `assertEventsSupported`)会**拒绝**「未知事件类型且非 ignorable」的会话日志(判据是生成的 `KNOWN_SESSION_EVENT_TYPES`,只含仓库内包声明的事件;仓库外插件事件不在其中)。

因此,仓库外插件**不能**往 session 日志追加自定义事件,否则该会话将无法被恢复。落地方案:
- park 的 held 消息、累计统计、暂停态 → 原子写入 `$DSH_HOME/peak-shift/<sessionId>.json`(`@deepseek-ai/dsh-atomic-write`);
- goal 暂停/恢复 → 复用 `dsh-goal` 自己的 `goal/change` 事件(仓库内,在 `KNOWN_SESSION_EVENT_TYPES` 内,安全);
- 统计 → 从 `assistant/message.usage` 等已有事件 fold,不新增事件。

### 6.2 `enforcement` 与 `mode` 的默认值

- `enforcement: 'gate'`(默认):只拦未发出的请求,绝不打断在途流式请求;`'cancel'` 为可选项。
- `mode: 'park'`(默认,与设计一致);`'defer'` 为进程内挂起、自愈;空 batch 的 park 会退化为 defer 挂起,避免丢弃工具循环续步。
