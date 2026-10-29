# TEST.md — 测试编写契约

写测试与改测试时遵循的四条纪律。来源：CI 上线五轮红的根因归类（2026-10-29，共同点：**本地全绿、CI 必红**——测试的通过前提里藏着只有开发宿主机满足的隐含假设）。评审测试类 diff 时逐条对照。

## 1. Fresh-machine test——前提里不得有本机状态

测试必须在一个"刚开机、啥都没装"的机器上同样通过。写完自查三个隐形依赖：

- **常驻进程的存在/缺席**（案例：launcher-log.test 曾依赖本机常驻 daemon 占 flock 才走超时抛错路径——干净 runner 上子进程正常拉起，`rejects` 断言红）
- **机器级锁 / 全局单例状态**（daemon 单实例锁是机器级，测试不得假设它被占或空闲）
- **时钟与调度时机**（见第 2 条）

失败注入用**构造出来的确定性输入**（如 socket 路径指向普通文件下 → ENOTDIR，任意机器同向崩溃），不用**碰到的环境状态**（如锁冲突）。

**妥协注释 = 债务标记**：凡写"无法注入 / 退而求其次 / 碰巧"的测试，必须同时登记它依赖的环境前提（issue 或本文件），并给 `shortcut:` 前缀注释。妥协不是问题，无声的妥协才是事故。

## 2. Await the goal state——等目标态，不等中间态

`waitFor` 的谓词必须直接描述**接下来要断言的那个状态**。两个已发作的形态：

- **跨段提交**：两段落库非原子时（outbox 写入 → fanOut 建投递行），等最终态（投递行 `parked`），不等中间态（outbox 有行）。中间条件当等待条件用，快机器上永远赢、慢 runner 上必输。
- **发送 ≠ 落地**：fire-and-forget 写（`startSession`、广播沿）返回只证客户端侧；必须 await **服务端观测面**（harness 暴露的 `sessionStarted`、store 查询）。`isConnected()` 只证 TCP 层，不证服务端已把连接登记进名册。

自检：`waitFor` 的条件描述与紧随的 `expect` 应是**同一个状态**。正典范式见 wake.test.ts 的 SESSION_START 屏障（票 40 收口注释）。

## 3. 声明 runner 形态——文件头注释即契约

非 vitest 套件（node:test、自跑断言脚本、`node:module` register 钩子 stub）在**测试文件头注释**写 canonical 跑法。`vitest` 收编不认识的形态会报 "No test suite found" 或直接杀掉 runner（自跑脚本的 `process.exit`）。

新包接入测试门时三步：文件头声明 canonical 跑法 → `.github/workflows/tests.yml` case 分支接原生 runner → 本地按 canonical 跑法跑绿。探针按文件名收编、按框架误判的教训见 workflow 内注释（四个原生特例的正典记录）。

## 4. 归零计数——门禁输出必须数数

全量门禁（depcruise / tsc / lint）的通过判据 = **违规计数归零**（`grep -c` 数出 0），不是"tail 没红"。违规信息和成功输出同流，tail 判断漏中段红（depcruise 首轮实证：既有违规藏在输出中段，收尾只看末行放行）。跑全量门禁的收尾动作固定为：数违规 → 归零 → 才算过。
