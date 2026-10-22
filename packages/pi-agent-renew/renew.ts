/**
 * pi-agent-renew — /renew: agent identity generational handover
 * Spec: ~/.agents/agents/SPEC.md (section 6 handover, section 7 on-duty discipline)
 * Flow: identity match -> STATE update -> validate -> prompt + audit file -> newSession + bookkeeping + auto-send.
 * v0.2: run-start latch fixes the waitForIdle race (2026-10-21 regen-gov incident);
 *       late-ready resume; renew.log persistence; agent-session-id tool.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ---------- module-level ready flag (set by the agent-renew-ready tool) ----------
let renewReady = false;
let renewArmed = false;

/**
 * True once the sendUserMessage instruction has actually started an agent run.
 * waitForIdle resolves immediately if called before any run starts (observed
 * 2026-10-21 regen-gov incident), so the command handler must latch on
 * agent_start before waiting for idle.
 */
let runStarted = false;

/** Set when agent-renew-ready is called while unarmed — evidence the agent
 *  finished its STATE update outside a valid window; next /renew resumes. */
let lateReadyAt: string | null = null;

function logRenewEvent(agentDir: string | null, kind: string, detail: string): void {
  const line = `${new Date().toISOString()} ${kind} ${detail}\n`;
  // In-session persistence via appendEntry happens at call sites; this file log
  // survives even if the session dies mid-renewal.
  if (agentDir) {
    try {
      appendFileSync(join(agentDir, "renew.log"), line);
    } catch {
      /* best effort */
    }
  }
}

// ---------- helpers ----------

/** Current session id from the session file name (…_<uuid>.jsonl). */
function currentSessionId(ctx: ExtensionCommandContext): string {
  const file = ctx.sessionManager.getSessionFile() ?? "";
  const base = basename(file, ".jsonl");
  const id = base.includes("_") ? base.slice(base.lastIndexOf("_") + 1) : base;
  return id || ctx.sessionManager.getSessionId();
}

/** Walk up from cwd to ~ looking for .agents/agents/. Returns nearest hit or null. */
function findAgentsRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".agents", "agents");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface OnDuty {
  agentName: string;
  agentDir: string;
  entryIndex: number;
  startedAt: string;
}

/** Find the agent whose last endedAt:null sessions.log entry matches sessionId. */
function matchIdentity(agentsRoot: string, sessionId: string): OnDuty | null {
  let names: string[];
  try {
    names = readdirSync(agentsRoot).filter((n) =>
      statSync(join(agentsRoot, n)).isDirectory()
    );
  } catch {
    return null;
  }
  for (const name of names) {
    const logPath = join(agentsRoot, name, "sessions.log");
    if (!existsSync(logPath)) continue;
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry.endedAt !== null && entry.endedAt !== undefined) continue; // not on duty
      // last endedAt:null entry for this agent — must match current session
      if (entry.sessionId === sessionId) {
        return {
          agentName: name,
          agentDir: join(agentsRoot, name),
          entryIndex: i,
          startedAt: String(entry.startedAt ?? ""),
        };
      }
      break; // this agent has an on-duty entry but it's someone else
    }
  }
  return null;
}

/**
 * Append-only style update of the old row's endedAt (edit only that field in
 * place — SPEC §6: 补全字段不算改历史；note 内容不动).
 */
function closeOnDutyEntry(agentDir: string, entryIndex: number, endedAt: string): void {
  const logPath = join(agentDir, "sessions.log");
  const lines = readFileSync(logPath, "utf8").split("\n");
  const entry = JSON.parse(lines[entryIndex]);
  entry.endedAt = endedAt;
  lines[entryIndex] = JSON.stringify(entry);
  writeFileSync(logPath, lines.join("\n"));
}

function appendSessionEntry(
  agentDir: string,
  sessionId: string,
  note: string,
  handoffFile: string
): void {
  const logPath = join(agentDir, "sessions.log");
  const entry = {
    sessionId,
    startedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    endedAt: null,
    note,
    handoffFile,
  };
  const body = readFileSync(logPath, "utf8");
  const needsNewline = body.length > 0 && !body.endsWith("\n");
  writeFileSync(logPath, body + (needsNewline ? "\n" : "") + JSON.stringify(entry) + "\n");
}

/** Extract SPEC §7 当值纪律 section (from the numbered list to the next ## or EOF). */
function extractSpecDiscipline(specPath: string): string {
  if (!existsSync(specPath)) return "（SPEC.md 不在，纪律见 ~/.agents/agents/SPEC.md §7）";
  const text = readFileSync(specPath, "utf8");
  const m = text.match(/## 7\.[\s\S]*?(?=\n## \d|\n## [^\d]|$)/);
  return m ? m[0].trim() : "（SPEC.md §7 未找到，请直接读 ~/.agents/agents/SPEC.md）";
}

/** Read the 交接附言 section from STATE.md (last ## section). */
function extractHandoffNote(statePath: string): string | null {
  if (!existsSync(statePath)) return null;
  const text = readFileSync(statePath, "utf8");
  const m = text.match(/##\s*交接附言\s*\n([\s\S]*?)(?=\n## |$)/);
  const body = m?.[1]?.trim();
  return body && body.length > 0 && !body.startsWith("（") ? body : null;
}

// ---------- prompt assembly (SPEC §6: 只放指针不复制内容) ----------

function buildInitialPrompt(
  agentDir: string,
  agentName: string,
  handoffNote: string
): string {
  const manifest = JSON.parse(readFileSync(join(agentDir, "AGENT.json"), "utf8"));
  // SPEC 唯一真相源在全局 workspace：~/.agents/agents/SPEC.md；工作区副本（若有）优先
  const workspaceSpec = join(agentDir, "..", "SPEC.md");
  const globalSpec = join(process.env.HOME ?? "", ".agents", "agents", "SPEC.md");
  const specPath = existsSync(workspaceSpec) ? workspaceSpec : globalSpec;
  const discipline = extractSpecDiscipline(specPath);

  return [
    `你现在就是 ${agentName}（${manifest.workspace} 的具名 agent，刚完成换届上岗）。`,
    "",
    "## 身份（按序读文件，本 prompt 只放指针不复制内容）",
    `- 身份卡: ${agentDir}/AGENT.json（name=${manifest.name}；resources 是换届记忆提醒非权限边界）`,
    `- 使命/职责/红线: ${agentDir}/charter.md（上岗必读）`,
    `- 协作拓扑: ${agentDir}/peers.md（需要协作时读）`,
    "",
    "## 当值纪律（SPEC.md §7 原文）",
    discipline,
    "",
    "## 状态",
    `- 战役快照与 Backlog: ${agentDir}/STATE.md（你就是它的当值维护者，保持新鲜）`,
    `- Backlog 第一条是下一步第一动作。`,
    "",
    "## 交接附言（上一届原话）",
    handoffNote,
    "",
    "上岗 checklist：",
    "1. 读上面四个文件确认现状（SESSION id 用 agent-session-id 工具取，sessions.log 上岗登记按 SPEC §7 纪律 5 追加，同时废弃前任悬空的 null 条目）；",
    "2. 核对前任名下的 daemon 订阅归属：订阅随 session 生死，将死 session 名下的订阅 cancel 后重挂到本 session（pi-events-daemon 继承功能在联合开发中，见其仓 ticket）；",
    "3. 按 STATE「活跃后台资产」节的可寻回标识找回脱离 session 的任务（远端节点脚本、-d 容器等）；",
    "4. 全部确认后从 STATE.md Backlog 第一条继续推进。",
  ].join("\n");
}

// ---------- extension ----------

export default function renewExtension(pi: ExtensionAPI) {
  // Latch: the sendUserMessage instruction turn has actually started.
  pi.on("agent_start", async () => {
    if (renewArmed) runStarted = true;
  });

  pi.registerTool({
    name: "agent-session-id",
    label: "Agent Session Id",
    description:
      "返回当前 pi session 的 UUID（sessions.log 登记必须用这个值，禁止手写或凭记忆——历届事故均源于手抄错 id）。无副作用。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, toolCtx) {
      const sid = toolCtx?.sessionManager?.getSessionId?.() ?? "unknown";
      return {
        content: [{ type: "text", text: sid }],
        details: { sessionId: sid },
      };
    },
  });

  pi.registerTool({
    name: "agent-renew-ready",
    label: "Agent Renew Ready",
    description:
      "换届流程专用：当 /renew 指令要求你更新 STATE.md（含交接附言）后，调用本工具向换届扩展确认就绪。非换届窗口调用会失败。",
    parameters: Type.Object({}),
    async execute() {
      if (!renewArmed) {
        const details: { armed: boolean; ready?: boolean } = { armed: false };
        lateReadyAt = new Date().toISOString();
        logRenewEvent(null, "LATE_READY", "agent-renew-ready called while unarmed (agent likely finished STATE update outside the window)");
        return {
          content: [
            {
              type: "text",
              text: "错误：当前没有进行中的换届窗口（/renew 未触发或已超时中止）。不要重复调用本工具；用户会重新执行 /renew，届时会检测到你已完成的 STATE 更新并直接续办。",
            },
          ],
          details,
        };
      }
      renewReady = true;
      return {
        content: [{ type: "text", text: "已确认就绪，换届流程继续。" }],
        details: { armed: true, ready: true } as { armed: boolean; ready?: boolean },
      };
    },
  });

  pi.registerCommand("renew", {
    description: "Agent 换届：更新 STATE → 原地新 session → 自动发送身份 prompt（SPEC.md §6）",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("/renew 需要交互模式", "error");
        return;
      }

      // 1. identity match
      const sessionId = currentSessionId(ctx);
      const agentsRoot = findAgentsRoot(ctx.cwd);
      if (!agentsRoot) {
        ctx.ui.notify("未找到 .agents/agents/（从 cwd 向上到 ~）。本目录不是 agent workspace。", "error");
        return;
      }
      const onDuty = matchIdentity(agentsRoot, sessionId);
      if (!onDuty) {
        ctx.ui.notify(
          `本 session (${sessionId.slice(0, 8)}) 不是任何 agent 的当值者（sessions.log 指纹不匹配）。先 agent-bootstrap 登记（用 agent-session-id 工具取 id）或等待接管通道。`,
          "error"
        );
        logRenewEvent(null, "ABORT_NO_IDENTITY", `session ${sessionId} matched no on-duty agent under ${agentsRoot}`);
        return;
      }

      // Late-ready resume: a previous window timed out but the agent already
      // finished its STATE update (called ready while unarmed). Skip re-instruction.
      const statePath = join(onDuty.agentDir, "STATE.md");
      const resumedNote = lateReadyAt ? extractHandoffNote(statePath) : null;
      const resuming = Boolean(resumedNote);

      if (!resuming) {
        // 2. instruct the agent to update STATE.md
        renewArmed = true;
        renewReady = false;
        runStarted = false;
        ctx.ui.notify(`换届开始：${onDuty.agentName} @ ${onDuty.agentDir}`, "info");
        logRenewEvent(onDuty.agentDir, "START", `session ${sessionId.slice(0, 8)} agent=${onDuty.agentName}`);
        pi.sendUserMessage(
          [
            "换届流程启动（/renew）。请按以下 checklist 逐项执行：",
            "1. 后台资产分类处置（SPEC §7 纪律 6）：",
            "   a. 绑定本 session 进程的（subagent、非 detached bg 任务）：等完成/收尾后再继续换届；确实等不了的先终止或写明交接处理方式；",
            "   b. 脱离 session 进程的（daemon 订阅、远端节点脚本、-d 容器等）：在 STATE.md「活跃后台任务」节记录可寻回标识（订阅 id/容器/节点名/任务 id），换屇后新 session 按标识找回；",
            "   c. daemon 订阅专项：把需要在换届后继续生效的订阅 cancel 掉，由新 session 重新挂（daemon 订阅随 session 生死，无法继承——继承功能在联合开发中，见 pi-events-daemon 仓 ticket）；",
            "2. 更新 STATE.md：刷新战役快照与活跃后台资产（含标识）、重排 Backlog、交接附言写实（本届做了什么/未完成什么/下一届第一动作），并附上隐性操作知识指针（哪些经验/教训/直觉判断沉淀在哪个文档，让下一届不用重新探索）——按 SPEC §7 纪律 4/7；",
            "3. 全部完成后调用 agent-renew-ready 工具确认。不要做其他事。",
          ].join("\n")
        );

        // 3. wait for the instruction turn to actually start, then for it to finish.
        // waitForIdle resolves immediately if no run has started yet (2026-10-21
        // regen-gov incident: sendUserMessage is async-fire, idle-check raced it).
        for (let i = 0; i < 100 && !runStarted; i++) {
          await new Promise((r) => setTimeout(r, 100)); // up to 10s for run start
        }
        if (!runStarted) {
          renewArmed = false;
          renewReady = false;
          ctx.ui.notify("换届中止：指令发出后 10s 内 agent turn 未启动（session 可能无模型或卡死）。", "error");
          logRenewEvent(onDuty.agentDir, "ABORT_NO_RUN_START", "instruction turn never started within 10s");
          return;
        }
        await ctx.waitForIdle();
      } else {
        renewReady = true; // late-ready call itself is the readiness proof
        ctx.ui.notify(`换届续办：检测到上一窗口超时后 agent 已完成 STATE 更新（${lateReadyAt}），直接进入校验。`, "info");
        logRenewEvent(onDuty.agentDir, "RESUME", `late-ready at ${lateReadyAt}, handoff note present`);
      }

      // 4. validate
      const handoffNote = resuming ? resumedNote : extractHandoffNote(statePath);
      if (!renewReady || !handoffNote) {
        renewArmed = false;
        renewReady = false;
        const why = !renewReady
          ? "agent 未调用 agent-renew-ready（可能中途提问或被中断）；若它实际已完成 STATE 更新，重新执行 /renew 会自动续办"
          : "STATE.md 的「交接附言」为空或仍是占位文本";
        ctx.ui.notify(`换届中止：${why}。处理后重新执行 /renew。`, "error");
        logRenewEvent(onDuty.agentDir, "ABORT_VALIDATION", why);
        return;
      }

      // 5. build prompt + audit file
      const prompt = buildInitialPrompt(onDuty.agentDir, onDuty.agentName, handoffNote);
      const handoffsDir = join(onDuty.agentDir, "handoffs");
      if (!existsSync(handoffsDir)) mkdirSync(handoffsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const handoffFile = join(handoffsDir, `${ts}-from-${sessionId.slice(0, 8)}.md`);
      writeFileSync(handoffFile, prompt);

      // 6. in-place session replacement + bookkeeping + auto-send
      const oldSessionId = sessionId;
      const agentDir = onDuty.agentDir;
      const endedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (replacementCtx) => {
          const newId = currentSessionId(replacementCtx as ExtensionCommandContext);
          closeOnDutyEntry(agentDir, onDuty.entryIndex, endedAt);
          appendSessionEntry(
            agentDir,
            newId,
            `换届自 ${oldSessionId.slice(0, 8)}（/renew 自动登记）`,
            handoffFile
          );
          await replacementCtx.sendUserMessage(prompt);
        },
      });

      if (result.cancelled) {
        // newSession was cancelled — revert bookkeeping didn't happen (writes are
        // inside withSession which doesn't run on cancel), so nothing to undo.
        ctx.ui.notify("换届取消（新 session 未创建）", "info");
        logRenewEvent(agentDir, "CANCELLED", "newSession cancelled by user");
      } else {
        logRenewEvent(agentDir, "DONE", `session ${oldSessionId.slice(0, 8)} -> new session, handoff=${handoffFile}`);
      }
      renewArmed = false;
      renewReady = false;
      runStarted = false;
      lateReadyAt = null;
    },
  });
}
