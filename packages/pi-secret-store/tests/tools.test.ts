/**
 * 工具与命令单测（走入口）：secret_query 三态（精确/模糊/无命中）+ secret_env 全量名单 +
 * /secret-store 命令（list/forget）+ secret_ensure 非 TUI throw。全程断言返回不含 value 明文。
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { valueProblem } from "../index.ts";
import { cleanupEnv, runExact, setupHarness, toolCtx } from "./helpers.ts";

afterEach(cleanupEnv);

const SEED = {
	HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "2026-10-20T00:00:00.000Z", fingerprint: "fp1234567890" },
	GITBLUE_TOKEN: { value: "gitblue-secret-value", updatedAt: "2026-10-19T00:00:00.000Z", fingerprint: "fp0987654321" },
	GITHUB_TOKEN: { value: "github-secret-value", updatedAt: "2026-10-18T00:00:00.000Z", fingerprint: "fp1111222233" },
};

describe("secret_query：三态", () => {
	it("精确命中 → 存在性详情（指纹/更新时间/bash 引用指引），不含明文", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_query", { name: "HARBOR_PASSWORD" });
		const text = out.content[0].text;
		expect(text).toContain("存在");
		expect(text).toContain("fp1234567890");
		expect(text).toContain("$HARBOR_PASSWORD");
		expect(text).not.toContain("harbor-secret-value");
	});

	it("fuzzy 模糊匹配（子序列、大小写不敏感）→ 匹配名单，不含明文", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_query", { name: "gt" }); // 子序列命中 GITHUB_TOKEN + GITBLUE_TOKEN
		const text = out.content[0].text;
		expect(text).toContain("GITHUB_TOKEN");
		expect(text).toContain("GITBLUE_TOKEN");
		expect(text).not.toContain("HARBOR_PASSWORD"); // 不匹配子序列
		for (const secret of Object.values(SEED)) expect(text).not.toContain(secret.value);
	});

	it("大小写不敏感模糊匹配", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_query", { name: "harbor" });
		expect(out.content[0].text).toContain("HARBOR_PASSWORD");
	});

	it("无命中 → 空名单提示（附已存凭证名或空存储提示），不含明文", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_query", { name: "ZZZ_NOPE" });
		const text = out.content[0].text;
		expect(text).toMatch(/不存在|无匹配/);
		expect(text).not.toContain("harbor-secret-value");
	});

	it("空存储 + 无命中 → 空名单提示", async () => {
		const h = await setupHarness();
		const out = await runExact(h, "secret_query", { name: "ANY" });
		expect(out.content[0].text).toMatch(/不存在|无匹配/);
	});

	it("空存储查询原型继承名（toString）→ 不存在（null 原型 + hasOwn，#126）", async () => {
		const h = await setupHarness();
		const out = await runExact(h, "secret_query", { name: "toString" });
		expect(out.content[0].text).toContain("不存在");
	});
});

describe("secret_env：全量名单（无参）", () => {
	it("非空存储 → 全部凭证的变量名+指纹+更新时间，不含 value 字段与明文", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_env", {});
		const text = JSON.stringify(out);
		expect(out.content[0].text).toContain("HARBOR_PASSWORD");
		expect(out.content[0].text).toContain("GITBLUE_TOKEN");
		expect(text).not.toContain("harbor-secret-value");
		expect(text).not.toContain("gitblue-secret-value");
		expect(text).not.toContain("github-secret-value");
		expect(text).not.toContain("value"); // 返回面不含 value 字段
	});

	it("空存储 → 空清单提示", async () => {
		const h = await setupHarness();
		const out = await runExact(h, "secret_env", {});
		expect(out.content[0].text).toContain("空");
	});

	it("description 写明不含值 + $NAME 引用（P1 互指文案）", async () => {
		const h = await setupHarness(SEED);
		const desc = h.tools.get("secret_env").description;
		expect(desc).toContain("$NAME");
		expect(desc.toLowerCase()).toMatch(/不含|never/);
	});
});

describe("/secret-store 命令", () => {
	it("list（缺省）→ 通知列名称+指纹，不含明文", async () => {
		const h = await setupHarness(SEED);
		await h.commands.get("secret-store").handler("", toolCtx(h));
		const joined = h.notifyLog.join("\n");
		expect(joined).toContain("HARBOR_PASSWORD");
		expect(joined).toContain("fp1234567890");
		expect(joined).not.toContain("harbor-secret-value");
	});

	it("forget <name> → 删除并同步 env 文件", async () => {
		const h = await setupHarness(SEED);
		await h.handlers.session_start[0]({ reason: "new" }, toolCtx(h));
		await h.commands.get("secret-store").handler("forget GITBLUE_TOKEN", toolCtx(h));
		const store = JSON.parse(await readFile(h.storePath, "utf8"));
		expect(store.secrets.GITBLUE_TOKEN).toBeUndefined();
		expect(store.secrets.HARBOR_PASSWORD).toBeDefined();
		const env = await readFile(h.envFile, "utf8");
		expect(env).not.toContain("GITBLUE_TOKEN");
	});

	it("空存储 list → 存储为空提示", async () => {
		const h = await setupHarness();
		await h.commands.get("secret-store").handler("", toolCtx(h));
		expect(h.notifyLog.join("\n")).toContain("空");
	});
});

describe("secret_ensure", () => {
	it("已存在 → 直接返回存在性，不弹窗", async () => {
		const h = await setupHarness(SEED);
		const out = await runExact(h, "secret_ensure", { name: "HARBOR_PASSWORD", label: "x", instructions: ["y"] });
		expect(out.content[0].text).toContain("已存在");
	});

	it("非 TUI + 缺失 → throw 引导（#125 拍板：不静默跳过）", async () => {
		const h = await setupHarness();
		await expect(runExact(h, "secret_ensure", { name: "NEW_ONE", label: "x", instructions: ["y"] }, { mode: "print", hasUI: false })).rejects.toThrow(/TUI/);
	});

	it("三个工具都已注册 + /secret-store 命令", async () => {
		const h = await setupHarness();
		expect([...h.tools.keys()].sort()).toEqual(["secret_ensure", "secret_env", "secret_query"]);
		expect(h.commands.has("secret-store")).toBe(true);
	});
});

describe("secret_ensure：录入前校验", () => {
	it("非法名（shell 元字符/连字符/数字开头/空格/空串）→ 错误文案，prompt 前拒绝不弹窗（[5]）", async () => {
		const h = await setupHarness();
		for (const name of ["X=1; printf injected; #", "bad-name", "9BAD", "HAS SPACE", ""]) {
			const out = await runExact(h, "secret_ensure", { name, label: "l", instructions: ["s"] });
			expect(out.content[0].text).toMatch(/非法/); // 若未先校验，tui ctx 会因 ui.custom 缺失而 throw
		}
	});

	it("保留名（PATH/IFS/SHELL* 前缀）→ 黑名单文案，prompt 前拒绝不弹窗（#126）", async () => {
		const h = await setupHarness();
		for (const name of ["PATH", "IFS", "SHELLOPTS", "SHELL_SESSION_ID"]) {
			const out = await runExact(h, "secret_ensure", { name, label: "l", instructions: ["s"] });
			expect(out.content[0].text).toContain("保留 shell 变量名");
		}
	});

	it("valueProblem：空值/NUL/短于 4 字符拒绝并说明脱敏原因，4 字符起通过（[7]/[9]）", () => {
		expect(valueProblem("")).toMatch(/不能为空/);
		expect(valueProblem("ab\0cd")).toMatch(/NUL/);
		expect(valueProblem("abc")).toMatch(/脱敏/);
		expect(valueProblem("abcd")).toBeUndefined();
		expect(valueProblem("a-long-enough-value")).toBeUndefined();
	});
});
