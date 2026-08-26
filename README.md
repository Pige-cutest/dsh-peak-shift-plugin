# dsh-peak-shift

把 dsh(DeepSeek Harness)里的长任务从「高峰计价时段」推迟到「空闲时段」执行,按 DeepSeek 的错峰计价规则(空闲价 = 高峰价 × 0.5)节省 token 费用。

内置的官方默认窗口:**北京时 周一至周五 09:00–12:00、14:00–18:00 为高峰;其余时间(含周末)为空闲**。

## 功能

- **高峰自动暂停**:进入高峰窗口时,目标 agent 的下一个 LLM 请求被拦下(不发出),有 active goal 的任务还会持久化 `goals.pause` 停掉 round-driver。
- **空闲自动续跑**:到达空闲起点时恢复 goal(`goals.resume`)、把被拦的请求重新投回 inbox(`agent.steer`),继续执行。
- **不打断在途请求**:默认 `enforcement: 'gate'`,只拦「尚未发出的请求」;已在途的流式请求让它自然排空。可选的 `enforcement: 'cancel'` 才会中止在途 turn(会浪费已流式输出的 tokens,默认关闭)。
- **提前刹车**:`leadMinutes` 在高峰开始前提前启动闸门,保证高峰边界上没有在途请求。
- **费用估算**:按配置的价格表与 `peakFactor/offPeakFactor`,把错峰后实际产生的 token 用量换算成「节省额」,通过工具/状态查看(估算,非账单)。
- **手动控制**:`peak_shift_pause` / `peak_shift_resume` / `peak_shift_status` / `peak_shift_stats` 四个 agent 工具。

## 安装

插件是 dsh 的 **bundle**(`package.json` 声明 `dsh.bundle.patch`),安装后会:
1. 被 pnpm 装进 profile 的 `node_modules`;
2. 自动加入该 profile 的 `dsh.profile.bundles`;
3. 其 `cordis.patch.yml` 插入 `peak-shift` 插件行。

### 从 GitHub 安装(推荐)

```bash
dsh plugin --profile web add github:Pige-cutest/dsh-peak-shift-plugin#v0.1.0
```

web profile 是默认用法。想让 **headless** 批量任务也错峰,单独建一个 profile:

```bash
dsh plugin --profile headless add github:Pige-cutest/dsh-peak-shift-plugin#v0.1.0
```

安装后重启对应 profile(web / headless),可确认配置树:

```bash
dsh --profile web --dump-config | grep -A5 peak-shift
```

### 本地开发安装

从插件仓库克隆/源码目录执行:

```bash
dsh plugin --profile web add ./dsh-peak-shift
```

> **依赖解析**:插件的 peer 依赖(`@deepseek-ai/*`)不随插件安装,由 dsh 启动时维护的 `$DSH_HOME/profiles/node_modules` 扁平回退目录解析,无需额外步骤。
>
> **build 脚本**:本包没有 `prepare`/build 步骤,`lib/` 直接随仓库发布,pnpm 安装时无需放行 build scripts。

## 配置

默认全部开箱即用。按需在 profile 的 `cordis.patch.yml` 覆盖:

```yaml
- id: peak-shift
  config:
    targets: [goal]              # 哪些 agent 参与:goal | headless | subagent | interactive
    windows:
      zone: Asia/Shanghai        # IANA 时区
      peak:                      # 高峰段;days 空 = 每天
        - days: [mon, tue, wed, thu, fri]
          ranges: ['09:00-12:00', '14:00-18:00']
    leadMinutes: 5               # 高峰前提前启动闸门(分钟)
    enforcement: gate            # gate(默认,只拦新请求) | cancel(中止在途 turn)
    mode: park                   # park(持久化停车) | defer(进程内挂起) | off(仅记录)
    pricing:                     # 节省额估算用的价格模型(非账单)
      currency: USD
      perMillion: { input: 0.27, cacheRead: 0.07, cacheWrite: 1.07, output: 1.1 }
      peakFactor: 1.0            # 高峰价 = 单价 × peakFactor
      offPeakFactor: 0.5         # 官方规则:空闲 = 高峰的一半
    startPolicy: park            # 高峰中新建的长任务:park(等空闲) | run(按高峰价照跑)
    pollIntervalMs: 30000        # 窗口状态轮询周期
    stateDir: ''                 # park 状态文件目录,空 = $DSH_HOME/peak-shift
```

### `mode` 说明

| 模式 | 行为 | 持久性 |
|---|---|---|
| `park`(默认) | 高峰请求被拦下(`agent/pre-step` 返回 reject),消息存进 sidecar;空闲时用 `agent.steer` 恢复 | **跨进程**:held 消息 + 累计统计持久化在 `$DSH_HOME/peak-shift/<sessionId>.json`(原子写入);goal 暂停/恢复本身由 `dsh-goal` 持久化 |
| `defer` | 高峰请求在 `agent/pre-step` 里挂起等待空闲,原批消息原样续跑 | 进程内;重启后由闸门自动重新拦下(自愈) |
| `off` | 不拦请求,只记录“本应错峰”的统计 | — |

## 工作原理

- **闸门**:在 `agent/pre-step`(waterfall)prepend 一个监听器。高峰 + 目标是长任务时,`defer` 模式不调用 `next()` 挂起等待,`park` 模式返回 `{ kind: 'reject' }` 收掉这一轮。请求从未发出 → 零 token 消耗。
- **长任务识别**:默认 `targets: [goal]` —— 只要 agent 有 goal(任意 phase)即视为长任务;`headless`/`subagent`/`interactive` 按需加入。
- **goal 暂停/恢复**:进入高峰时 `ctx.goals.pause(agent, ref)`(持久化 `active→paused`,round-driver 停止续轮,避免“followup→拦截→blocked”日志膨胀);空闲时 `ctx.goals.resume()` 重新 armed,round-driver 自动续下一轮。
- **状态与统计**:每个 agent 一个 runtime(`agent/created` 创建),窗口判定用 `Intl` 按时区计算星期几+分钟;节省额 = 错峰后实际 `assistant/message.usage` 的 token × 单价 × `(peakFactor − offPeakFactor)`。

## 模型工具

- `peak_shift_status` — 当前窗口、暂停态、下次切换、累计节省。
- `peak_shift_pause [reason]` / `peak_shift_resume` — 手动覆盖窗口。
- `peak_shift_stats` — 价格模型与累计明细。

## 测试

纯逻辑(windows/stats/runtime)测试需要能解析 `@deepseek-ai/*` 依赖。在插件目录建立到本机 dsh 安装的 junction 后:

```bash
# 一次性(指向你本机 dsh 的真实依赖树)
cmd /c "mklink /J node_modules\\@deepseek-ai \"%APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\""
npm test
```

## 已知限制

- **故障安全**:任何 peak-shift 内部错误只记告警,**绝不打断 agent 创建或 LLM 请求**。在工具服务不可用的组合(如 web 的 agent-preset 平面)会自动跳过 `peak_shift_*` 工具,pre-step 闸门照常工作。
- **估算非账单**:节省额按配置价格表计算,DeepSeek 实际扣费以官方账单为准;价格表可按实际校准。
- **sidecar 非 session 日志**:park 的 held 消息存在独立文件,不参与 session 的 replay/导出;若 sidecar 丢失,闸门会在下一个高峰自动重新拦下(自愈)。
- **defer 挂起期间 agent 保持 `running`**:暂停的请求等待期间,该 agent 的 turn 不关闭(这是有意的)。
- **交互会话默认不参与**:只有 `targets` 命中(默认 goal)才错峰;普通对话不受影响。

## 与 dsh 官方包的关系

- 复用:`agent/pre-step`、`agent.steer/cancel`、`ctx.goals.pause/resume`、`ctx.sessions.flush`、`ctx.timer`、`dsh-tools` 工具注册、`dsh-atomic-write`、`dsh-home-paths`。
- 不写入 session 日志自定义事件(仓库外插件的事件类型无法被持久化读取路径识别,会导致会话无法恢复),因此 park 状态走 sidecar 文件。
