/**
 * 钩子链 pi 契约冒烟（#179 起规则断言迁至 tests/injection.test.ts 直调，本文件只留必须经 extension
 * harness 验证的契约面）：原地 mutate 生效与拼装形态、防重标记（MARKER）、block 返回形态、
 * session_start（env 退役/guard 清单单一来源）与三工具面（bash/read/grep）、P1 次序、fail closed（[6]）、
 * redactor 累积（[4]）。
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnv, runToolCall, setupHarness, toolResultEvent } from "./helpers.ts";

const bashRun = promisify(execFile);

afterEach(cleanupEnv);

describe("tool_call：选择性注入（#170，原地 mutate）", () => {
	it("语义锁①引用什么注入什么：$NAME/${NAME} 拼写、原地 mutate、原命令保持完整在后", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" },
			B_TOKEN: { value: "b-token-value-2", updatedAt: "t", fingerprint: "fp0000bb22" },
			C_TOKEN: { value: "c-token-value-3", updatedAt: "t", fingerprint: "fp0000cc33" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = `printf '%s' "$A_TOKEN \${B_TOKEN}"`;
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined(); // 注入不返回值
		expect(event.input.command).toBe(
			`: __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1' B_TOKEN='b-token-value-2'; ${cmd}`,
		);
		expect(event.input.command).not.toContain("C_TOKEN"); // 未引用的不进环境
	});

	it("非 bash 工具不注入", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "some/path", "read");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("some/path"); // read 的 input.command 原样（未被注入触碰）
	});

	it("语义锁②没引用不注入：空前缀，命令与无凭证库时逐字节一致（不报错，零 I/O 直通端到端）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("go build ./..."); // 无 marker、无 export、无任何前缀
	});

	it("值含特殊字符：逐变量 shellQuote 不破坏命令，bash 实取逐字节还原（[4]/[11]）", async () => {
		const values: Record<string, string> = {
			A_CMD: "$(printf changed)",
			B_HOME: "$HOME",
			C_BT: "`id`",
			D_NL: "line1\nline2",
			E_Q: "it's",
		};
		const h = await setupHarness(
			Object.fromEntries(Object.entries(values).map(([n, v]) => [n, { value: v, updatedAt: "t", fingerprint: "f" }])),
		);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const refs = Object.keys(values).map((n) => `$${n}`).join("|");
		const { event } = await runToolCall(h, `printf '%s' "${refs}" | base64 -w0`);
		const { stdout } = await bashRun("bash", ["-c", event.input.command]);
		const got = Buffer.from(stdout.trim(), "base64").toString("utf8").split("|");
		expect(got).toEqual(Object.values(values));
	});

	it("MARKER 防重（③）：已带前缀（嵌套/重放）的命令不重复注入，原样放行", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = ": __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1'; echo $A_TOKEN";
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(cmd);
	});
});

describe("tool_call：明文回填（#172，pi 契约冒烟：端到端拼装/累积语义/P1 次序；判定规则见 injection.test.ts）", () => {
	it("命令含已存明文（裸 token）→ 替换为 $NAME 后走注入路径（端到端：命令体无明文）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "echo a-token-value-1");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(": __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1'; echo $A_TOKEN");
	});

	it("forget 后旧值仍可回填（redactor 累积语义一致）；回填产物未存名 → 静默跳过不注入，mutate 后含 $NAME 不含明文", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await writeFile(h.storePath, JSON.stringify({ secrets: {} }), { mode: 0o600 }); // 他 session forget
		const { event, result } = await runToolCall(h, "echo a-token-value-1");
		expect(result).toBeUndefined(); // 未存名静默跳过（语义锁③），不报错
		expect(event.input.command).toBe("echo $A_TOKEN"); // 无 export 前缀
		expect(event.input.command).not.toContain("a-token-value-1");
	});

	it("P1 检测先于回填：已知格式 token 即使已存入 store 仍被 P1 拦截（不因回填放行）", async () => {
		const h = await setupHarness({
			GH_TOKEN: { value: "glpat-AbCdEfGhIjKlMnOpQrStUv", updatedAt: "t", fingerprint: "fp0000gg11" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "echo glpat-AbCdEfGhIjKlMnOpQrStUv";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(event.input.command).toBe(cmd); // P1 拦截时命令未被回填改写
	});
});

describe("session_start：env 文件退役（#170）", () => {
	it("不再生成 env 文件；遗留 env 文件被物理删除；guard 不再拦 env 路径", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await writeFile(join(h.agentDir, "secret-store.env"), "A_TOKEN='legacy-value'\n", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await expect(stat(join(h.agentDir, "secret-store.env"))).rejects.toThrow(/ENOENT/);
		const { result, event } = await runToolCall(h, `cat ${h.agentDir}/secret-store.env`);
		expect(result).toBeUndefined(); // guard 只保护 store json
		expect(event.input.command).toBe(`cat ${h.agentDir}/secret-store.env`); // 无 $ 引用 → 无注入
	});

	it("unlink 非 ENOENT 失败 → warning 通知，明文副本滞留不静默（rolling-review-r1 #2）", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限位，无法构造 EACCES
		const h = await setupHarness();
		const legacy = join(h.agentDir, "secret-store.env");
		await writeFile(legacy, "A_TOKEN='legacy-value'\n", { mode: 0o600 });
		await chmod(h.agentDir, 0o500); // 目录不可写 → unlink EACCES
		try {
			await h.handlers.session_start[0]({ reason: "new" }, { hasUI: true, ui: { notify: (msg: string) => h.notifyLog.push(msg) } });
		} finally {
			await chmod(h.agentDir, 0o700); // 恢复以便 cleanupEnv 递归删除
		}
		expect(h.notifyLog.join("\n")).toMatch(/secret-store\.env/);
		await expect(stat(legacy)).resolves.toBeTruthy(); // 文件仍在（删除失败）
	});

	it("删除失败期间 legacy env 纳入 guard 保护（fail closed，r3 #2）：cat/文件工具被拦，成功删除后解除", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限位，无法构造 EACCES
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		const legacy = join(h.agentDir, "secret-store.env");
		await writeFile(legacy, "A_TOKEN='legacy-value'\n", { mode: 0o600 });
		await chmod(h.agentDir, 0o500); // 目录不可写 → unlink EACCES
		try {
			await h.handlers.session_start[0]({ reason: "new" }, { hasUI: true, ui: { notify: (msg: string) => h.notifyLog.push(msg) } });
		} finally {
			await chmod(h.agentDir, 0o700);
		}
		const cat = await runToolCall(h, `cat ${legacy}`);
		expect(cat.result?.block).toBe(true);
		expect(cat.result?.reason).toContain("secret_query");
		const rd = await runToolCall(h, { path: legacy }, "read");
		expect(rd.result?.block).toBe(true);
		// 成功删除后保护解除（「直到成功删除」）：重跑 session_start 删除成功
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await expect(stat(legacy)).rejects.toThrow(/ENOENT/);
		const after = await runToolCall(h, `cat ${legacy}`);
		expect(after.result).toBeUndefined();
	});

	it("删除失败状态跨实例共享（r4 #6 模块级）：实例 B 未跑 session_start 也受 guard 保护，删除成功后解除", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限位，无法构造 EACCES
		const agentDir = await mkdtemp(join(tmpdir(), "pi-secret-store-r4-6-"));
		const legacy = join(agentDir, "secret-store.env");
		await writeFile(legacy, "A_TOKEN='legacy-value'\n", { mode: 0o600 });
		const hA = await setupHarness(undefined, agentDir);
		await chmod(agentDir, 0o500); // 目录不可写 → 实例 A unlink EACCES
		try {
			await hA.handlers.session_start[0]({ reason: "new" }, { hasUI: true, ui: { notify: (msg: string) => hA.notifyLog.push(msg) } });
		} finally {
			await chmod(agentDir, 0o700);
		}
		expect(hA.notifyLog.join("\n")).toMatch(/secret-store\.env/);
		// 实例 B：同 agentDir 新 factory 实例，不跑 session_start——实例级状态则感知不到 A 的删除失败
		const hB = await setupHarness(undefined, agentDir);
		const catB = await runToolCall(hB, `cat ${legacy}`);
		expect(catB.result?.block).toBe(true);
		// 下次删除成功 → 解除（持续到任一实例下次删除成功）
		await hB.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await expect(stat(legacy)).rejects.toThrow(/ENOENT/);
		const catB2 = await runToolCall(hB, `cat ${legacy}`);
		expect(catB2.result).toBeUndefined();
		await rm(agentDir, { recursive: true, force: true });
	});
});

describe("tool_call：存储 guard（拦读存储文件本身）", () => {
	it("读 secret-store.json → block，文案引导用 secret_query，且不注入前缀", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `cat ${h.agentDir}/secret-store.json`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("secret_query");
		expect(event.input.command).not.toContain("__PI_SECRET_STORE__"); // guard 拦截 → 无注入
	});

	it("路径变体不再绕过字面子串：~/.. 拼写与 cwd 相对路径同样拦截（[7]）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// `..` 变体：字面子串不包含 storePath，resolve 归一后命中
		const variant = join(h.agentDir, "..", basename(h.agentDir), "secret-store.json");
		const dot = await runToolCall(h, `cat ${variant}`);
		expect(dot.result?.block).toBe(true);
		// 相对路径 + ctx.cwd=agentDir
		const rel = await runToolCall(h, "cat ./secret-store.json", "bash", { cwd: h.agentDir });
		expect(rel.result?.block).toBe(true);
	});

	it("受保护路径字面兜底覆盖全部保护面（r5 #1）：含空格/引号拼写的 keyPath/agePath 读取被拦", async () => {
		// agentDir 含空格：token 化把路径切碎、逐 token resolve 不中——此前仅 storePath 有字面兜底，
		// keyPath（身份密钥=全部明文）可借含空格/引号拼写绕过 guard
		const base = await mkdtemp(join(tmpdir(), "pi-ss-space-"));
		const h = await setupHarness(undefined, join(base, "agent dir"));
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const key = await runToolCall(h, `cat "${join(h.agentDir, "secret-store.key")}"`);
		expect(key.result?.block).toBe(true);
		const age = await runToolCall(h, `cat "${join(h.agentDir, "secret-store.json.age")}"`);
		expect(age.result?.block).toBe(true);
		await rm(base, { recursive: true, force: true });
	});

	it("confPath（secret-store.conf）纳入保护面（r6 #1）：bash 改写后端配置被拦，相对路径形态同拦", async () => {
		// conf 被改写可把后端切到 plain 写回明文正典（绕过“缺省不落明文”边界），与密文/密钥同受保护
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const abs = await runToolCall(h, `echo "backend = plain" > ${h.agentDir}/secret-store.conf`);
		expect(abs.result?.block).toBe(true);
		expect(abs.result?.reason).toContain("secret_query");
		const rel = await runToolCall(h, "sed -i 's/age/plain/' ./secret-store.conf", "bash", { cwd: h.agentDir });
		expect(rel.result?.block).toBe(true);
	});

	it("read/grep 类文件工具的 path 指向存储文件 → block（文案同，[7]）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const r = await runToolCall(h, { path: `${h.agentDir}/secret-store.json` }, "read");
		expect(r.result?.block).toBe(true);
		expect(r.result?.reason).toContain("secret_query");
		const g = await runToolCall(h, { pattern: "x", path: `${h.agentDir}/secret-store.json` }, "grep");
		expect(g.result?.block).toBe(true);
	});

	it("含 secret-store 字样的无关路径不误伤（子串边界）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { result } = await runToolCall(h, "cat ~/notes/secret-store.md");
		expect(result).toBeUndefined();
	});

	it("保护面清单单一来源（#179 B 节）：同一清单同时覆盖路径解析面（read path）与子串兜底面（bash 拼写）", async () => {
		// 清单收敛后（protectedPaths 单一构造，两比对面遍历同一数组），清单内每个保护面两个比对面都命中
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		for (const file of ["secret-store.key", "secret-store.json.age", "secret-store.conf"]) {
			const read = await runToolCall(h, { path: `${h.agentDir}/${file}` }, "read");
			expect(read.result?.block).toBe(true); // 路径解析面（isProtectedPath）
			const bash = await runToolCall(h, `cat "${join(h.agentDir, file)}"`);
			expect(bash.result?.block).toBe(true); // 子串兜底面（touchesStore）
		}
	});
});

describe("tool_call：跨 session 脱敏一致（[8]）", () => {
	it("他 session 后写入的凭证：注入前 reload store 并注册进 redactor，输出被脱敏", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// 模拟另一 session 的保存（直接写盘，本实例未重跑 session_start）
		await writeFile(
			h.storePath,
			JSON.stringify({ secrets: { LATER_SECRET: { value: "later-secret-value", updatedAt: "t", fingerprint: "fp11112222" } } }),
			{ mode: 0o600 },
		);
		await runToolCall(h, "printf '%s' \"$LATER_SECRET\""); // 注入链应同步 reload+注册
		const out = await h.handlers.tool_result[0](toolResultEvent("later-secret-value"), {});
		expect(JSON.stringify(out)).toContain("[REDACTED]");
	});
});

describe("tool_call：P1 检测先于注入（block 时命令保持原样）", () => {
	it("明文凭证命令 → block 且 event.input.command 未被注入（检测看到原始命令）", async () => {
		const h = await setupHarness();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "curl -H 'Authorization: Bearer glpat-AbCdEfGhIjKlMnOpQrStUv' https://x";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(event.input.command).toBe(cmd); // 无前缀、无改写
	});
});

describe("tool_call：存储不可读 → fail closed（[6]）", () => {
	it("损坏 json + 引用变量 → bash 调用被 block，不注入", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{ corrupt", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `printf '%s' "$A_TOKEN"`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("凭证注入已停用");
		expect(event.input.command).not.toContain("__PI_SECRET_STORE__"); // 未注入前缀
	});

	it("损坏 json + 无引用命令 → 直通不拦（注入集为空 = 与无凭证库一致，#170）", async () => {
		const h = await setupHarness();
		await writeFile(h.storePath, "{ corrupt", { mode: 0o600 });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("go build ./...");
	});
});

describe("tool_call：redactor 累积不 clear（[4]）", () => {
	it("存 TOKEN → 他 session forget → bash 链 reload 后，旧值输出仍 [REDACTED]", async () => {
		const h = await setupHarness({ TOKEN: { value: "tok-secret-value-123", updatedAt: "t", fingerprint: "fp01234567" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		// 他 session forget：直接改盘（本实例不重跑 session_start）
		await writeFile(h.storePath, JSON.stringify({ secrets: {} }), { mode: 0o600 });
		// bash 调用触发注入链 reload（旧实现在此 clear 掉 TOKEN → 明文裸奔）
		await runToolCall(h, "cat /tmp/saved-token");
		const out = await h.handlers.tool_result[0](toolResultEvent("tok-secret-value-123"), {});
		expect(JSON.stringify(out)).toContain("[REDACTED]");
	});
});
