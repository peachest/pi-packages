/**
 * 钩子链单测（走入口）：tool_call 选择性注入语义锁（#170：引用什么注入什么 / 没引用不注入 /
 * 未存名不注入）、展开式形态不计引用（rolling-review-r1 #1）、allowedPrefix 首词限定（#171）、
 * 明文回填（#172：P1 检测 → 回填 → prefix/注入 的链路定型）、结构化前缀不误判（r2 #2）、
 * 值特殊字符逐变量 shellQuote、env 文件退役（含 unlink 非 ENOENT 告警）、存储 guard（bash resolved 变体 +
 * read 类文件工具，[7]，#170 后只保护 store json）、顺序（P1 检测在注入前，block 时不注入）、
 * fail closed（[6]）、redactor 累积（[4]）。
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

	it("语义锁②没引用不注入：空前缀，命令与无凭证库时逐字节一致（不报错）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "go build ./...");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("go build ./..."); // 无 marker、无 export、无任何前缀
	});

	it("语义锁③未存名不注入且不影响其他名：静默跳过（P1 白名单语义）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, `printf '%s' "$MISSING_TOKEN $A_TOKEN"`);
		expect(result).toBeUndefined(); // 不报错
		expect(event.input.command).toContain("export A_TOKEN='a-token-value-1'");
		expect(event.input.command).not.toContain("MISSING_TOKEN='");
		// 纯未存名引用：命令完全不动
		const { event: e2 } = await runToolCall(h, `printf '%s' "$MISSING_TOKEN"`);
		expect(e2.input.command).toBe(`printf '%s' "$MISSING_TOKEN"`);
	});

	it("展开式形态不计入引用（rolling-review-r1 #1）：未存名展开式零改动直通（r8 #3 后已存名走 block，见独立 describe）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		const cmd = 'echo "${MISSING:-d}" "${MISSING:=d}" "${MISSING:+a}" "${MISSING:?e}"';
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(cmd); // 不注入不拦截：命令逐字节一致
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
});

describe("tool_call：allowedPrefix 凭证限定（#171）", () => {
	const PREFIXED = {
		HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11", allowedPrefix: ["harbor", "nerdctl"] },
		OPEN_TOKEN: { value: "open-token-value", updatedAt: "t", fingerprint: "fp0000oo11" },
	};

	it("首词命中 → 正常注入（token 化容错：前导空白不影响首词解析）", async () => {
		const h = await setupHarness(PREFIXED);
		const { event, result } = await runToolCall(h, "  nerdctl login $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("首词是前缀的扩展拼写同样命中（前缀语义：首词以前缀开头）", async () => {
		const h = await setupHarness(PREFIXED);
		const { event, result } = await runToolCall(h, "nerdctl-compose up $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("首词不命中 → 不注入 + block 报错三要素（凭证名/限定前缀/secret_ensure 指引）", async () => {
		const h = await setupHarness(PREFIXED);
		const cmd = "git push $HARBOR_PASSWORD";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("harbor");
		expect(result?.reason).toContain("nerdctl");
		expect(result?.reason).toContain("secret_ensure");
		expect(event.input.command).toBe(cmd); // 命令未被注入改写
	});

	it("wrapper 命令真命令词（r3 #3）：sh -c / bash -lc 载荷递归取词，不再误判为 sh/bash", async () => {
		const h = await setupHarness(PREFIXED);
		for (const cmd of [
			`sh -c "nerdctl login $HARBOR_PASSWORD"`,
			// r5 #2：单引号载荷内的已存名引用改为 block（fail closed），本行用双引号形态锁同一命令词递归语义
			`bash -lc "harbor project list $HARBOR_PASSWORD"`,
			`sudo sh -c "nerdctl login $HARBOR_PASSWORD"`,
			`nohup nerdctl login $HARBOR_PASSWORD`,
		]) {
			const { event, result } = await runToolCall(h, cmd);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
	});

	it("命令词解析不出（仅 wrapper/赋值形态）→ 单独文案（r6 #2）：报无法解析，不再出现空命令词引号", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, "env HARBOR_PASSWORD=$HARBOR_PASSWORD");
		expect(result?.block).toBe(true); // fail closed 不变：空命令词不命中任何前缀
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("nerdctl");
		expect(result?.reason).toContain("secret_ensure");
		expect(result?.reason).toContain("无法从命令解析命令词");
		expect(result?.reason).not.toContain('当前命令词 ""');
	});

	it("wrapper 不命中仍 block，报错点名真命令词而非 wrapper（r3 #3）", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, `sh -c "git push $HARBOR_PASSWORD"`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("git");
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("secret_ensure");
	});

	it("bash 无 -c（脚本路径场景）→ 比对词就是 shell 名，保持 r2 行为", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, `bash deploy.sh $HARBOR_PASSWORD`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('当前命令词 "bash"');
	});

	it("多前缀任一命中即可（第二个前缀 harbor 命中）", async () => {
		const h = await setupHarness(PREFIXED);
		const { event, result } = await runToolCall(h, "harbor project list $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("空数组 = 任意命令可用，与票1行为完全一致（向后兼容）", async () => {
		const h = await setupHarness({
			HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11", allowedPrefix: [] },
		});
		const { event, result } = await runToolCall(h, "git push $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(
			": __PI_SECRET_STORE__; export HARBOR_PASSWORD='harbor-secret-value'; git push $HARBOR_PASSWORD",
		);
	});

	it("无前缀限制的其他凭证照常注入（限定只作用于被限定者）", async () => {
		const h = await setupHarness(PREFIXED);
		const { event, result } = await runToolCall(h, "nerdctl login $HARBOR_PASSWORD $OPEN_TOKEN");
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("HARBOR_PASSWORD='harbor-secret-value'");
		expect(event.input.command).toContain("OPEN_TOKEN='open-token-value'");
	});

	it("sudo/env/赋值前缀三形态不误判（r2 #2）：剥非命令 token 后取真命令词比对", async () => {
		const h = await setupHarness(PREFIXED);
		for (const cmd of [
			"sudo nerdctl login $HARBOR_PASSWORD",
			"env nerdctl login $HARBOR_PASSWORD",
			"ENV=prod nerdctl login $HARBOR_PASSWORD",
		]) {
			const { event, result } = await runToolCall(h, cmd);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
	});

	it("wrapper 选项 token 不是命令词（r4 #4）：sudo -E / env -i / timeout 10 后取真命令词比对", async () => {
		const h = await setupHarness(PREFIXED);
		for (const cmd of [
			"sudo -E nerdctl login $HARBOR_PASSWORD",
			"env -i nerdctl login $HARBOR_PASSWORD",
			"timeout 10 nerdctl login $HARBOR_PASSWORD",
		]) {
			const { event, result } = await runToolCall(h, cmd);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
	});

	it("sudo 无参选项 -s/-k 不吞真命令词（r7 #3）：带参选项表按 wrapper 区分，带参者保持跳参", async () => {
		const h = await setupHarness(PREFIXED);
		// 旧实现：-s/-k 被当带参选项 i++ 吞掉 nerdctl → 命令词错位 fail-closed 误 block（红）
		for (const cmd of ["sudo -s nerdctl login $HARBOR_PASSWORD", "sudo -k nerdctl login $HARBOR_PASSWORD"]) {
			const { event, result } = await runToolCall(h, cmd);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
		// 确知带参的组合保持（GNU/sudo 手册语义）：sudo -u/-g、env -u、timeout -k/-s
		for (const cmd of [
			"sudo -u alice nerdctl login $HARBOR_PASSWORD",
			"sudo -g wheel nerdctl login $HARBOR_PASSWORD",
			"timeout -k 5 nerdctl login $HARBOR_PASSWORD",
			"timeout -s KILL 10 nerdctl login $HARBOR_PASSWORD",
			"env -u FOO nerdctl login $HARBOR_PASSWORD",
		]) {
			const { event, result } = await runToolCall(h, cmd);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
	});

	it("裸数字时长仅在 timeout 之后剥离（r5 #4）：非 timeout 位置的数字开头/裸数字首词按命令词比对", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11", allowedPrefix: ["7z"] },
			B_TOKEN: { value: "b-token-value-2", updatedAt: "t", fingerprint: "fp0000bb22", allowedPrefix: ["10"] },
		});
		// 数字开头命令（brief 点名 7z x 类）：regression lock，首词不被当 wrapper 时长跳过
		const seven = await runToolCall(h, "7z x archive.7z $A_TOKEN");
		expect(seven.result).toBeUndefined();
		expect(seven.event.input.command).toContain("export A_TOKEN='a-token-value-1'");
		// 裸数字首词：老实现对任意位置裸数字 token 生效 → 命令词误取 "serve" → 限定凭证 fail-closed 误 block
		const bare = await runToolCall(h, "10 serve $B_TOKEN");
		expect(bare.result).toBeUndefined();
		expect(bare.event.input.command).toContain("export B_TOKEN='b-token-value-2'");
	});

	it("选项跳过不放松 fail closed：sudo -E 后真命令词不命中仍 block（r4 #4）", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, "sudo -E git push $HARBOR_PASSWORD");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('当前命令词 "git"');
	});

	it("block 报错点名实际参与比对的命令词（r2 #2）：sudo git push → 比对词是 git 而非 sudo", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, "sudo git push $HARBOR_PASSWORD");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("git");
		expect(result?.reason).toContain("HARBOR_PASSWORD");
	});

	it("混用不命中：限定凭证不命中仍 block（fail closed），报错点名限定凭证", async () => {
		const h = await setupHarness(PREFIXED);
		const cmd = "git push $OPEN_TOKEN $HARBOR_PASSWORD";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(event.input.command).toBe(cmd);
	});

	it("管道分段（r8 #4）：消费段在管道后 → 任一段命中即放行（旧实现只比首段命令词，误 block）", async () => {
		const h = await setupHarness(PREFIXED);
		const { event, result } = await runToolCall(h, "unrelated | nerdctl login $HARBOR_PASSWORD");
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("&&/;/|| 链分段（r8 #4）：前置段不命中、后续段命中 → 放行", async () => {
		const h = await setupHarness(PREFIXED);
		for (const op of ["&&", ";", "||"]) {
			const { event, result } = await runToolCall(h, `git status ${op} nerdctl login $HARBOR_PASSWORD`);
			expect(result).toBeUndefined();
			expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
		}
	});

	it("分段 fail closed（r8 #4）：所有段均不命中 → block，报错列出各段命令词", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, "cat /etc/hosts | git push $HARBOR_PASSWORD");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("cat");
		expect(result?.reason).toContain("git");
	});

	it("引号内的 | 不是段边界（r8 #4 同源扫描）：引号内伪造命中段不生效", async () => {
		const h = await setupHarness(PREFIXED);
		const { result } = await runToolCall(h, 'git push "msg | harbor" $HARBOR_PASSWORD');
		expect(result?.block).toBe(true); // 单段命令词 git；naive 切分把引号内 harbor 当独立段会误放行
		expect(result?.reason).toContain('当前命令词 "git"');
	});
});

describe("tool_call：单引号内已注入名引用 block（r5 #2）", () => {
	const SEED = { HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11" } };

	it("sudo sh -c 'echo $NAME' → block：单引号延迟展开 + sudo 清环境取空值照常执行（fail closed），提示改双引号", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, "sudo sh -c 'echo $HARBOR_PASSWORD'");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("双引号");
	});

	it("env -i sh -c 'echo $NAME' → block（清环境同缺口）", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, "env -i sh -c 'echo $HARBOR_PASSWORD'");
		expect(result?.block).toBe(true);
	});

	it("双引号形态照常注入（外层展开，注入值对内层可达）：bash -c \"echo $NAME\" 不拦", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, 'bash -c "echo $HARBOR_PASSWORD"');
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("r6 #5：'\\'' 拼接形态与 redact commandContext 同源判定——拼接段内的已存名引用仍 block", async () => {
		const h = await setupHarness(SEED);
		// 'echo ok'\''$NAME' ≡ echo ok'$NAME'：'\'' 拼接后的段仍在单引号内
		const { result } = await runToolCall(h, "sudo sh -c 'echo ok'\\''$HARBOR_PASSWORD'");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
	});

	it("r6 #5：双引号内撇号不再误判单引号（近似 split 删除）——\"it's $NAME\" 照常注入", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, `bash -c "echo it's $HARBOR_PASSWORD"`);
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("单引号内未存名引用不拦（未注入即无缺口）", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, "sh -c 'echo $MISSING_NAME'");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe("sh -c 'echo $MISSING_NAME'");
	});
});

describe("tool_call：展开式引用命中已存名 block（r8 #3）", () => {
	const SEED = { HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11" } };

	it("${NAME:-def} 命中已存名 → block：展开式不注入真值（r1 #1），命令带空/默认值照常执行，与 r5 #2 同缺口 fail closed", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD:-default}"');
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(result?.reason).toContain("展开式");
		expect(result?.reason).toContain("$HARBOR_PASSWORD"); // 改写指引（与 r5 #2 同文案族）
	});

	it("${NAME:?msg} 命中已存名 → block（同文案族）", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD:?missing}"');
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
	});

	it("纯 ${NAME} 花括号形态仍照常注入（非展开式，不受 r8 #3 影响）", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD}"');
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("r9 #1：纯展开+字面后缀（${NAME}/config、${NAME}-suffix）不判展开式——照常注入不 block", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD}/config" "${HARBOR_PASSWORD}-suffix"');
		expect(result).toBeUndefined(); // 旧正则 [^}] 把 } 后的字面后缀误判为展开操作符 → 误 block（红）
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("r9 #1：纯 ${NAME} 花括号不因旧正则回溯截断误判展开式（存名与截断前缀名并存）", async () => {
		const h = await setupHarness({
			...SEED,
			HARBOR_PASSWOR: { value: "prefix-value-9999", updatedAt: "t", fingerprint: "fp0000pw99" }, // HARBOR_PASSWORD 截去末字符
		});
		const { event, result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD}"');
		// 旧正则 [^}] 回溯：${HARBOR_PASSWORD} → m[1]=HARBOR_PASSWOR（截断）命中已存名 → 纯花括号注入路径被误 block（红）
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("r9 #1 回归锁：${NAME:-def} 操作符形态仍判展开式 block（r8 #3 语义在收紧后保持）", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD:=d}"');
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
	});

	it("展开式引用未存名不拦（r1 #1 白名单语义）：命令逐字节原样", async () => {
		const h = await setupHarness(SEED);
		const cmd = 'echo "${MISSING_VAR:-d}"';
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(cmd);
	});

	it("混用：未存名展开式不影响已存名注入", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(h, 'echo "${MISSING_VAR:-d}" $HARBOR_PASSWORD');
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});
});

describe("tool_call：r10 #1 操作符锚定在 } 之内（rolling-review-r10）", () => {
	const SEED = { HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11" } };

	it("验收表·不 block：${NAME}+字面后缀（-suffix、/path、#x、?）逐形态不判展开式——走纯注入", async () => {
		const h = await setupHarness(SEED);
		const { event, result } = await runToolCall(
			h,
			'echo "${HARBOR_PASSWORD}-suffix" "${HARBOR_PASSWORD}/path" "${HARBOR_PASSWORD}#x" "${HARBOR_PASSWORD}?"',
		);
		expect(result).toBeUndefined();
		expect(event.input.command).toContain("export HARBOR_PASSWORD='harbor-secret-value'");
	});

	it("验收表·不 block：未闭合花括号 ${NAME-suffix（bash bad substitution，命令本就不执行）不判展开式", async () => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, 'echo "${HARBOR_PASSWORD-suffix');
		expect(result).toBeUndefined();
	});

	it.each([
		["${NAME:-def}", 'echo "${HARBOR_PASSWORD:-def}"'],
		["${NAME:=x}", 'echo "${HARBOR_PASSWORD:=x}"'],
		["${NAME:?m}", 'echo "${HARBOR_PASSWORD:?m}"'],
		["${NAME:+a}", 'echo "${HARBOR_PASSWORD:+a}"'],
		["${NAME:-}", 'echo "${HARBOR_PASSWORD:-}"'],
		["${NAME-def}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD-def}"'],
		["${NAME=x}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD=x}"'],
		["${NAME+a}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD+a}"'],
		["${NAME?m}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD?m}"'],
		["${NAME#pat}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD#pat}"'],
		["${NAME%pat}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD%pat}"'],
		["${NAME/pat/rep}（裸操作符紧贴 NAME）", 'echo "${HARBOR_PASSWORD/pat/rep}"'],
	])("验收表·block：展开式 %s 命中已存名仍 block", async (_label, cmd) => {
		const h = await setupHarness(SEED);
		const { result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
	});

	it("r9 语义回归锁：${NAME:0:3} 子串展开（冒号后接数字）仍放行——不判展开式不拦也不注入", async () => {
		const h = await setupHarness(SEED);
		const cmd = 'echo "${HARBOR_PASSWORD:0:3}"';
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(cmd);
	});
});

describe("tool_call：明文回填（#172，链路定型 P1 检测 → 回填 → prefix/注入；r3 #1 起替换仅限裸 token）", () => {
	it("命令含已存明文（裸 token）→ 替换为 $NAME 后走注入路径（端到端：命令体无明文）", async () => {
		const h = await setupHarness({ A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "echo a-token-value-1");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(": __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1'; echo $A_TOKEN");
	});

	it("明文出现在命令中段/多值混排均替换（裸 token）；未命中 store 值的文本逐字节原样（不误伤）", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" },
			B_TOKEN: { value: "b-token-value-2", updatedAt: "t", fingerprint: "fp0000bb22" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const mixed = `printf '%s' pre-a a-token-value-1 mid b-token-value-2 post`;
		const { event } = await runToolCall(h, mixed);
		expect(event.input.command).toBe(
			`: __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1' B_TOKEN='b-token-value-2'; printf '%s' pre-a $A_TOKEN mid $B_TOKEN post`,
		);
		const plain = "echo totally-unrelated-text";
		const { event: e2, result: r2 } = await runToolCall(h, plain);
		expect(r2).toBeUndefined();
		expect(e2.input.command).toBe(plain);
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

	it("同一明文对应多凭证名（防御形态，值唯一性由 store 保证）→ 取最长名替换", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "same-secret-value-99", updatedAt: "t", fingerprint: "fp0000aa11" },
			LONGER_A_TOKEN: { value: "same-secret-value-99", updatedAt: "t", fingerprint: "fp0000ll11" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "echo same-secret-value-99");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(
			": __PI_SECRET_STORE__; export LONGER_A_TOKEN='same-secret-value-99'; echo $LONGER_A_TOKEN",
		);
	});

	it("回填值含正则特殊字符（$ . ] [）：正确转义命中，替换后注入 shellQuote 逐字节还原", async () => {
		const h = await setupHarness({ WEIRD: { value: "p$ss.w0rd]x[9", updatedAt: "t", fingerprint: "fp0000ww11" } });
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "echo p$ss.w0rd]x[9");
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(": __PI_SECRET_STORE__; export WEIRD='p$ss.w0rd]x[9'; echo $WEIRD");
	});

	it("回填产物走 allowedPrefix 决策：限定凭证明文写进不命中命令 → block（不因回填绕过限定），命令无明文", async () => {
		const h = await setupHarness({
			HARBOR_PASSWORD: { value: "harbor-secret-value", updatedAt: "t", fingerprint: "fp0000hh11", allowedPrefix: ["nerdctl"] },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const { event, result } = await runToolCall(h, "git push harbor-secret-value");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("HARBOR_PASSWORD");
		expect(event.input.command).not.toContain("harbor-secret-value"); // 已回填为 $NAME
	});
});

describe("tool_call：回填边界与数据形态（rolling-review-r3 #1）", () => {
	const SEED_A = { A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" } };

	it("引号字符串内命中（单引号）→ block 不改写：报错含凭证名/数据语义原因/$NAME 指引三要素", async () => {
		const h = await setupHarness(SEED_A);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "echo 'a-token-value-1'";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("A_TOKEN");
		expect(result?.reason).toContain("数据语义");
		expect(result?.reason).toContain("$A_TOKEN");
		expect(result?.reason).toContain("secret_env");
		expect(event.input.command).toBe(cmd); // 不改写
	});

	it("JSON payload/双引号字符串内命中 → block（静默改写会篡改数据语义）", async () => {
		const h = await setupHarness({
			A_TOKEN: { value: "a-token-value-1", updatedAt: "t", fingerprint: "fp0000aa11" },
			B_TOKEN: { value: "b-token-value-2", updatedAt: "t", fingerprint: "fp0000bb22" },
		});
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = `printf '%s' "pre a-token-value-1 mid b-token-value-2 post"`;
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("A_TOKEN");
		expect(result?.reason).toContain("B_TOKEN");
		expect(event.input.command).toBe(cmd);
	});

	it("heredoc 体命中 → block（heredoc 是数据位）", async () => {
		const h = await setupHarness(SEED_A);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "cat <<EOF\na-token-value-1\nEOF";
		const { event, result } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("A_TOKEN");
		expect(event.input.command).toBe(cmd);
	});

	it("命令替换体内命中 → block（r7 #2）：$( ) 与反引号体是数据位，不机械改写", async () => {
		const h = await setupHarness(SEED_A);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const sub = "curl $(echo a-token-value-1)";
		const subRes = await runToolCall(h, sub);
		expect(subRes.result?.block).toBe(true); // 旧实现：$() 体当裸 token 机械替换，语义静默改变（红）
		expect(subRes.result?.reason).toContain("A_TOKEN");
		expect(subRes.event.input.command).toBe(sub); // 阻断不改写
		const bt = "echo `echo a-token-value-1`";
		const btRes = await runToolCall(h, bt);
		expect(btRes.result?.block).toBe(true);
		expect(btRes.event.input.command).toBe(bt);
	});

	it("r9 #4：$() 内嵌双引号含 ) —— 双引号内的 ) 不误减深度，其后替换体明文仍判数据位 block", async () => {
		const h = await setupHarness(SEED_A);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = 'curl $(echo "a)b" a-token-value-1)';
		const { result, event } = await runToolCall(h, cmd);
		expect(result?.block).toBe(true); // 旧实现：引号内 ) 误减深度 → 其后命中沦为裸 token 被机械改写（红）
		expect(result?.reason).toContain("A_TOKEN");
		expect(event.input.command).toBe(cmd); // 阻断不改写
	});

	it("heredoc 结束后的命令位命中 → 正常裸 token 回填（heredoc 不吞后续命令）", async () => {
		const h = await setupHarness(SEED_A);
		await h.handlers.session_start[0]({ reason: "new" }, { hasUI: false });
		const cmd = "cat <<'EOF'\ndoc-body\nEOF\necho a-token-value-1";
		const { event, result } = await runToolCall(h, cmd);
		expect(result).toBeUndefined();
		expect(event.input.command).toBe(
			": __PI_SECRET_STORE__; export A_TOKEN='a-token-value-1'; cat <<'EOF'\ndoc-body\nEOF\necho $A_TOKEN",
		);
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
