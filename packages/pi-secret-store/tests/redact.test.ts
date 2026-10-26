/**
 * Redactor 单测（走入口，经 tool_result / context 钩子驱动 redactDeep）：
 * 值替换、多行值的行级替换、最短长度门槛、深拷贝不变异入参、双 secret 单遍交替正则行为对齐。
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { commandContext, IN_HEREDOC, IN_SUBST } from "../lib/redact.ts";
import { cleanupEnv, contextEvent, runToolCall, setupHarness, toolResultEvent } from "./helpers.ts";

afterEach(cleanupEnv);

const SECRET = "super-secret-value-1234";

async function harnessWithSecrets() {
	return setupHarness({
		TOKEN_A: { value: SECRET, updatedAt: "x", fingerprint: "aaaa1111" },
		TOKEN_B: { value: "second-secret-abcdef-9876", updatedAt: "x", fingerprint: "bbbb2222" },
		MULTI: { value: "line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret", updatedAt: "x", fingerprint: "cccc3333" },
		SHORT: { value: "abc", updatedAt: "x", fingerprint: "dddd4444" }, // < MIN_REDACT_LENGTH=4，不参与脱敏
	});
}

describe("redactor：tool_result 脱敏", () => {
	it("明文值被替换为 [REDACTED]，且入参 content 不被变异（深拷贝）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(`log line with ${SECRET} inside`);
		const result = await h.handlers.tool_result[0](event, {});
		expect(result).toBeDefined();
		expect(result.content[0].text).toBe("log line with [REDACTED] inside");
		expect(event.content[0].text).toContain(SECRET); // 原事件未被改写
	});

	it("无命中 → 返回 undefined（不替换 content 引用）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent("nothing sensitive here");
		expect(await h.handlers.tool_result[0](event, {})).toBeUndefined();
	});

	it("多行密钥：整值与足够长的单行都被替换（长短优先，整值先赢）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent("out: line-one-of-multiline-secret-xx / second-line-of-multiline-secret");
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe("out: [REDACTED] / [REDACTED]");
	});

	it("短值（<4 字符）不脱敏", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent("value abc stays");
		expect(await h.handlers.tool_result[0](event, {})).toBeUndefined();
	});

	it("同一文本内两个不同 secret 都被替换（单遍交替正则）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(`${SECRET} and second-secret-abcdef-9876`);
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe("[REDACTED] and [REDACTED]");
	});

	it("session_start 重载（fork/重连）后脱敏集与 store 重建一致", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		await h.handlers.session_start[0]({ reason: "fork" }, { hasUI: false });
		const event = toolResultEvent(`leak ${SECRET} / second-secret-abcdef-9876`);
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe("leak [REDACTED] / [REDACTED]");
	});
});

describe("redactor：details / 对象键 / JSON 转义（rolling-review-r1 批 B 修复）", () => {
	it("[15] tool_result details 同步脱敏（仅 details 变更也返回结果，content 原样透传）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent("clean", { out: `leak ${SECRET}` });
		const result = await h.handlers.tool_result[0](event, {});
		expect(result).toBeDefined();
		expect(result.details.out).toBe("leak [REDACTED]");
		expect(result.content[0].text).toBe("clean");
	});

	it("[15] content 与 details 同时命中 → 两者都返回脱敏结果", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(`body ${SECRET}`, { out: SECRET });
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe("body [REDACTED]");
		expect(result.details.out).toBe("[REDACTED]");
	});

	it("[14] 对象 key 命中已注册值 → 键名替换为 [REDACTED]（嵌套各层，结构保持）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent("clean", { [SECRET]: "v", nested: { keep: 1, [SECRET]: { deep: true } } });
		const result = await h.handlers.tool_result[0](event, {});
		const out = JSON.stringify(result.details);
		expect(out).not.toContain(SECRET);
		expect(out).toBe('{"[REDACTED]":"v","nested":{"keep":1,"[REDACTED]":{"deep":true}}}');
	});

	it("[16] 存储值含引号时，JSON 序列化转义形态（abcd\\\"efgh）同样命中", async () => {
		const h = await setupHarness({ Q: { value: 'abcd"efgh', updatedAt: "x", fingerprint: "eeee5555" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(JSON.stringify({ field: 'abcd"efgh' }));
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe('{"field":"[REDACTED]"}');
	});

	it("[16] CRLF 值的 JSON 转义 \\r\\n 序列命中（转义覆盖原始值形态，#126）", async () => {
		const h = await setupHarness({ CRLF: { value: "abcd\r\nefgh", updatedAt: "x", fingerprint: "ffff6666" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(JSON.stringify({ field: "abcd\r\nefgh" }));
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe('{"field":"[REDACTED]"}');
	});

	it("[16] 原始字面量形态仍命中（转义注册不排挤字面量）", async () => {
		const h = await setupHarness({ Q: { value: 'abcd"efgh', updatedAt: "x", fingerprint: "eeee5555" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = toolResultEvent(`raw ${'abcd"efgh'} end`);
		const result = await h.handlers.tool_result[0](event, {});
		expect(result.content[0].text).toBe("raw [REDACTED] end");
	});
});

describe("redactor：alternation 编译缓存（r3 #4）", () => {
	it("后续 add 使缓存失效：新注册值立即命中脱敏，旧值持续命中（热路径不重复编译且无陈旧正则）", async () => {
		const h = await setupHarness({ TOKEN_A: { value: SECRET, updatedAt: "x", fingerprint: "aaaa1111" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const first = await h.handlers.tool_result[0](toolResultEvent(`one ${SECRET}`), {});
		expect(first?.content[0].text).toBe("one [REDACTED]");
		// 他 session 写入新凭证 → 注入链 reload → add 触发缓存失效
		await writeFile(
			h.storePath,
			JSON.stringify({
				secrets: {
					TOKEN_A: { value: SECRET, updatedAt: "x", fingerprint: "aaaa1111" },
					TOKEN_B: { value: "second-secret-abcdef-9876", updatedAt: "x", fingerprint: "bbbb2222" },
				},
			}),
			{ mode: 0o600 },
		);
		await runToolCall(h, "printf '%s' \"$TOKEN_B\""); // reload：新值注册进 redactor
		const out = await h.handlers.tool_result[0](toolResultEvent(`${SECRET} and second-secret-abcdef-9876`), {});
		expect(out?.content[0].text).toBe("[REDACTED] and [REDACTED]");
	});
});

describe("redactor：context 脱敏", () => {
	it("messages 内嵌套字符串被替换，无命中返回 undefined", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const event = contextEvent([`ctx leak ${SECRET}`, "clean"]);
		const result = await h.handlers.context[0](event, {});
		expect(result.messages[0].content).toBe("ctx leak [REDACTED]");
		expect(result.messages[1].content).toBe("clean");
		const clean = contextEvent(["clean"]);
		expect(await h.handlers.context[0](clean, {})).toBeUndefined();
	});
});

describe("redactor：转义变体回填边界（r4 #5）", () => {
	const MULTILINE_CMD = String.raw`echo line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret`;

	it("裸位命中 JSON 转义变体 → 原样保留（字面 \\n 非原始值形态，回填会篡改字面数据）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, MULTILINE_CMD);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(MULTILINE_CMD); // red：会机械替换为 $MULTI 篡改字面量
	});

	it("转义变体数据位命中仍阻断（仅在数据位走 dataHits，不静默放行泄密载荷）", async () => {
		const h = await harnessWithSecrets();
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = `curl -d '${String.raw`{"v":"line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret"}`}'`;
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("MULTI");
		expect(event.input.command).toBe(cmd); // 阻断不改写
	});

	it("转义变体跳过不吞重叠短值命中（r7 #5）：lastIndex 回退，短值照常回填", async () => {
		const h = await setupHarness({
			MULTI: { value: "ab\ncdef", updatedAt: "x", fingerprint: "cccc3333" },
			PART: { value: "ncdef", updatedAt: "x", fingerprint: "dddd4444" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = String.raw`echo ab\ncdef`; // 字面 \n：MULTI 转义变体裸位命中（不回填，r4 #5），重叠其内的 PART 裸值照常回填
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		// 旧实现：g 正则消费转义变体后 continue，PART 在重叠起点的命中被吞（红）
		expect(event.input.command).toContain("$PART");
		expect(event.input.command).toContain("export PART=");
	});
});

// review-high #4：commandContext 交叠/嵌套形态行为固化——锁当前行为防漂移（不论对错，已知不支持清单见
// lib/redact.ts commandContext 注释）。库级直 import（age.test.ts 先例）；位置索引显式标注便于对照。
describe("commandContext：交叠/嵌套形态行为固化（review-high #4）", () => {
	it("heredoc 体与命令替换交叠：体仅 IN_HEREDOC（$() 深度不跨 heredoc），终止行与收尾 ) 落裸位", () => {
		const cmd = "$(cat <<EOF\ninner-cmd\nEOF\n)";
		const ctx = commandContext(cmd);
		expect(ctx[0] & IN_SUBST).toBeTruthy(); // 0=$ 1=( ：替换开启
		expect(ctx[1] & IN_SUBST).toBeTruthy();
		for (let i = 12; i <= 20; i++) expect(ctx[i]).toBe(IN_HEREDOC); // 12-20 = heredoc 体 inner-cmd
		expect(ctx[cmd.length - 1]).toBe(0); // 收尾 ) 落裸位
	});

	it("替换体内 case 的 pattern ) 提前闭合 substDepth：其后替换体全落裸位（守卫级近似，锁现状）", () => {
		const cmd = "$(case x in a) echo one;; esac)";
		const ctx = commandContext(cmd);
		for (let i = 0; i <= 12; i++) expect(ctx[i] & IN_SUBST).toBeTruthy(); // 0-12 = $(case x in a
		expect(ctx[13]).toBe(0); // 13 = pattern ) 提前闭合
		for (let i = 14; i < cmd.length; i++) expect(ctx[i]).toBe(0); // 14+ = echo one;; esac) 全裸位
	});

	it("反引号与 $() 混合嵌套：内层整体 IN_SUBST，收尾反引号落裸位", () => {
		const cmd = "echo `a $(b) c`";
		const ctx = commandContext(cmd);
		for (let i = 5; i <= 13; i++) expect(ctx[i] & IN_SUBST).toBeTruthy(); // 5-13 = `a $(b) c`
		expect(ctx[cmd.length - 1]).toBe(0); // 收尾 `
	});

	it("算术 $((1+2))：体 IN_SUBST，收尾 )) 落裸位（内层 ( 不加深度的近似）", () => {
		const cmd = "echo $((1+2))";
		const ctx = commandContext(cmd);
		for (let i = 5; i <= 10; i++) expect(ctx[i] & IN_SUBST).toBeTruthy(); // 5-10 = $((1+2
		expect(ctx[11]).toBe(0); // 11-12 = ))
		expect(ctx[12]).toBe(0);
	});

	it("process substitution <( )> 不跟踪：体内 | ; 落裸位（commandSegments 会当段边界，已知漂移）", () => {
		const cmd = "diff <(a|b) >(c;d)";
		const ctx = commandContext(cmd);
		for (let i = 0; i < cmd.length; i++) expect(ctx[i]).toBe(0);
	});
});
