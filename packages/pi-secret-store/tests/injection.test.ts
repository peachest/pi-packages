/**
 * 注入规划模块直调规则测试（#179）：命令文本分析判定（引用集/展开式/单引号/allowedPrefix 段比对/
 * 回填与数据位/上下文位/预判谓词）直调 planInjection / hasInjectableRef / commandContext，不经
 * extension harness。本文件是 hooks.test.ts 既有规则断言的等价对应物（行为等价对账，非逐字照搬）；
 * pi 契约冒烟（原地 mutate 形态/防重/block 返回形态/session_start 工具面）仍在 hooks.test.ts。
 */
import { describe, expect, it } from "vitest";
import { commandContext, hasInjectableRef, IN_HEREDOC, IN_SUBST, planInjection, type Store } from "../index.ts";

const ent = (value: string, allowedPrefix?: string[]): Store[string] => ({
	value,
	updatedAt: "t",
	fingerprint: "fp",
	...(allowedPrefix ? { allowedPrefix } : {}),
});

describe("planInjection：选择性注入 assignments（#170 语义锁直调）", () => {
	it("语义锁①规则面：引用 ∩ 已存名才进 assignments（$NAME/${NAME} 混排、首现顺序）", () => {
		const store: Store = {
			A_TOKEN: ent("a-token-value-1"),
			B_TOKEN: ent("b-token-value-2"),
			C_TOKEN: ent("c-token-value-3"),
		};
		const plan = planInjection(`printf '%s' "$A_TOKEN \${B_TOKEN}"`, store, {});
		expect(plan.block).toBeUndefined();
		expect(plan.text).toBeUndefined();
		expect(plan.assignments).toEqual(["A_TOKEN='a-token-value-1'", "B_TOKEN='b-token-value-2'"]); // 未引用的 C_TOKEN 不进
	});

	it("语义锁③规则面：未存名静默跳过不影响其他名；纯未存名 → 无 assignments 无 block", () => {
		const store: Store = { A_TOKEN: ent("a-token-value-1") };
		const plan = planInjection(`printf '%s' "$MISSING_TOKEN $A_TOKEN"`, store, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["A_TOKEN='a-token-value-1'"]);
		const plan2 = planInjection(`printf '%s' "$MISSING_TOKEN"`, store, {});
		expect(plan2).toEqual({}); // 纯未存名：不拦不注入不改写
	});

	it("展开式形态不计入引用（rolling-review-r1 #1）：未存名展开式零改动直通（r8 #3 后已存名走 block，见独立 describe）", () => {
		const store: Store = { A_TOKEN: ent("a-token-value-1") };
		const plan = planInjection('echo "${MISSING:-d}" "${MISSING:=d}" "${MISSING:+a}" "${MISSING:?e}"', store, {});
		expect(plan).toEqual({}); // 不注入不拦截不改写
	});

	it("纯 ${NAME} 花括号形态照常注入（非展开式，r8 #3 不影响）", () => {
		const store: Store = { HARBOR_PASSWORD: ent("harbor-secret-value") };
		const plan = planInjection('echo "${HARBOR_PASSWORD}"', store, {});
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("值含特殊字符：逐变量 shellQuote 单引号字面量（与 hooks.test.ts bash 实取逐字节还原配对，[4]/[11]）", () => {
		const store: Store = {
			A_CMD: ent("$(printf changed)"),
			B_HOME: ent("$HOME"),
			C_BT: ent("`id`"),
			D_NL: ent("line1\nline2"),
			E_Q: ent("it's"),
		};
		const refs = Object.keys(store).map((n) => `$${n}`).join("|");
		const plan = planInjection(`printf '%s' "${refs}"`, store, {});
		expect(plan.assignments).toEqual([
			"A_CMD='$(printf changed)'",
			"B_HOME='$HOME'",
			"C_BT='`id`'",
			"D_NL='line1\nline2'",
			"E_Q='it'\\''s'",
		]);
	});

	it("单引号内未存名引用不拦（未注入即无缺口）", () => {
		const store: Store = { HARBOR_PASSWORD: ent("harbor-secret-value") };
		const plan = planInjection("sh -c 'echo $MISSING_NAME'", store, {});
		expect(plan).toEqual({});
	});
});

describe("planInjection：allowedPrefix 凭证限定（#171 直调）", () => {
	const PREFIXED: Store = {
		HARBOR_PASSWORD: ent("harbor-secret-value", ["harbor", "nerdctl"]),
		OPEN_TOKEN: ent("open-token-value"),
	};

	it("首词命中 → assignments（token 化容错：前导空白不影响首词解析）", () => {
		const plan = planInjection("  nerdctl login $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("首词是前缀的扩展拼写同样命中（前缀语义：首词以前缀开头）", () => {
		const plan = planInjection("nerdctl-compose up $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("首词不命中 → block 报错三要素（凭证名/限定前缀/forget+重录指引），无 assignments 无 text", () => {
		const plan = planInjection("git push $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.block).toContain("harbor");
		expect(plan.block).toContain("nerdctl");
		expect(plan.block).toContain("/secret-store forget HARBOR_PASSWORD");
		expect(plan.assignments).toBeUndefined();
		expect(plan.text).toBeUndefined();
	});

	it("wrapper 命令真命令词（r3 #3）：sh -c / bash -lc 载荷递归取词，不再误判为 sh/bash", () => {
		for (const cmd of [
			'sh -c "nerdctl login $HARBOR_PASSWORD"',
			'bash -lc "nerdctl login $HARBOR_PASSWORD"',
		]) {
			const plan = planInjection(cmd, PREFIXED, {});
			expect(plan.block).toBeUndefined();
			expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		}
	});

	it("wrapper 选项 token 不是命令词（r4 #4）：sudo -E / env -i / timeout 10 后取真命令词比对", () => {
		for (const cmd of [
			"sudo -E nerdctl login $HARBOR_PASSWORD",
			"env -i nerdctl login $HARBOR_PASSWORD",
			"timeout 10 nerdctl login $HARBOR_PASSWORD",
		]) {
			const plan = planInjection(cmd, PREFIXED, {});
			expect(plan.block).toBeUndefined();
			expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		}
	});

	it("sudo 无参选项 -s/-k 不吞真命令词（r7 #3）：带参选项表按 wrapper 区分，带参者保持跳参", () => {
		// 旧实现：-s/-k 被当带参选项 i++ 吞掉 nerdctl → 命令词错位 fail-closed 误 block（红）
		for (const cmd of ["sudo -s nerdctl login $HARBOR_PASSWORD", "sudo -k nerdctl login $HARBOR_PASSWORD"]) {
			const plan = planInjection(cmd, PREFIXED, {});
			expect(plan.block).toBeUndefined();
			expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		}
		// 确知带参的组合保持（GNU/sudo 手册语义）：sudo -u/-g、env -u、timeout -k/-s
		for (const cmd of [
			"sudo -u alice nerdctl login $HARBOR_PASSWORD",
			"sudo -g wheel nerdctl login $HARBOR_PASSWORD",
			"timeout -k 5 nerdctl login $HARBOR_PASSWORD",
			"timeout -s KILL 10 nerdctl login $HARBOR_PASSWORD",
			"env -u FOO nerdctl login $HARBOR_PASSWORD",
		]) {
			const plan = planInjection(cmd, PREFIXED, {});
			expect(plan.block).toBeUndefined();
			expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		}
	});

	it("命令词解析不出（仅 wrapper/赋值形态）→ 单独文案（r6 #2）：报无法解析，不再出现空命令词引号", () => {
		const plan = planInjection("env HARBOR_PASSWORD=$HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD"); // fail closed 不变：空命令词不命中任何前缀
		expect(plan.block).toContain("nerdctl");
		expect(plan.block).toContain("/secret-store forget HARBOR_PASSWORD");
		expect(plan.block).toContain("无法从命令解析命令词");
		expect(plan.block).not.toContain('当前命令词 ""');
	});

	it("wrapper 不命中仍 block，报错点名真命令词而非 wrapper（r3 #3）", () => {
		const plan = planInjection(`sh -c "git push $HARBOR_PASSWORD"`, PREFIXED, {});
		expect(plan.block).toContain("git");
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.block).toContain("/secret-store forget HARBOR_PASSWORD");
	});

	it("bash 无 -c（脚本路径场景）→ 比对词就是 shell 名，保持 r2 行为", () => {
		const plan = planInjection(`bash deploy.sh $HARBOR_PASSWORD`, PREFIXED, {});
		expect(plan.block).toContain('当前命令词 "bash"');
	});

	it("多前缀任一命中即可（第二个前缀 harbor 命中）", () => {
		const plan = planInjection("harbor project list $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("空数组 = 任意命令可用，与票1行为完全一致（向后兼容）", () => {
		const store: Store = { HARBOR_PASSWORD: ent("harbor-secret-value", []) };
		const plan = planInjection("git push $HARBOR_PASSWORD", store, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("无前缀限制的其他凭证照常注入（限定只作用于被限定者）", () => {
		const plan = planInjection("nerdctl login $HARBOR_PASSWORD $OPEN_TOKEN", PREFIXED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual([
			"HARBOR_PASSWORD='harbor-secret-value'",
			"OPEN_TOKEN='open-token-value'",
		]);
	});

	it("裸数字时长仅在 timeout 之后剥离（r5 #4）：非 timeout 位置的数字开头/裸数字首词按命令词比对", () => {
		const store: Store = {
			A_TOKEN: ent("a-token-value-1", ["7z"]),
			B_TOKEN: ent("b-token-value-2", ["10"]),
		};
		// 数字开头命令（brief 点名 7z x 类）：regression lock，首词不被当 wrapper 时长跳过
		const seven = planInjection("7z x archive.7z $A_TOKEN", store, {});
		expect(seven.block).toBeUndefined();
		expect(seven.assignments).toEqual(["A_TOKEN='a-token-value-1'"]);
		// 裸数字首词：老实现对任意位置裸数字 token 生效 → 命令词误取 "serve" → 限定凭证 fail-closed 误 block
		const bare = planInjection("10 serve $B_TOKEN", store, {});
		expect(bare.block).toBeUndefined();
		expect(bare.assignments).toEqual(["B_TOKEN='b-token-value-2'"]);
	});

	it("选项跳过不放松 fail closed：sudo -E 后真命令词不命中仍 block（r4 #4）", () => {
		const plan = planInjection("sudo -E git push $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain('当前命令词 "git"');
	});

	it("block 报错点名实际参与比对的命令词（r2 #2）：sudo git push → 比对词是 git 而非 sudo", () => {
		const plan = planInjection("sudo git push $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("git");
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("混用不命中：限定凭证不命中仍 block（fail closed），报错点名限定凭证", () => {
		const plan = planInjection("git push $OPEN_TOKEN $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.assignments).toBeUndefined();
	});

	it("管道分段（r8 #4）：消费段在管道后 → 任一段命中即放行（旧实现只比首段命令词，误 block）", () => {
		const plan = planInjection("unrelated | nerdctl login $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("&&/;/|| 链分段（r8 #4）：前置段不命中、后续段命中 → 放行", () => {
		for (const op of ["&&", ";", "||"]) {
			const plan = planInjection(`git status ${op} nerdctl login $HARBOR_PASSWORD`, PREFIXED, {});
			expect(plan.block).toBeUndefined();
			expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		}
	});

	it("分段 fail closed（r8 #4）：所有段均不命中 → block，报错列出各段命令词", () => {
		const plan = planInjection("cat /etc/hosts | git push $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.block).toContain("cat");
		expect(plan.block).toContain("git");
	});

	it("引号内的 | 不是段边界（r8 #4 同源扫描）：引号内伪造命中段不生效", () => {
		const plan = planInjection('git push "msg | harbor" $HARBOR_PASSWORD', PREFIXED, {});
		expect(plan.block).toContain('当前命令词 "git"'); // 单段命令词 git；naive 切分把引号内 harbor 当独立段会误放行
	});

	// review-high #1：凭证真正被消费的位置是 $NAME 所在段——不引用凭证的段命中前缀不构成放行
	it("per-credential 段比对：引用段不命中、无引用段命中 → block（echo $TOKEN | nerdctl ps 管道绕过收口）", () => {
		const plan = planInjection("echo $HARBOR_PASSWORD | nerdctl ps", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.assignments).toBeUndefined();
	});

	it("per-credential 段比对：顺序拼接同款绕过收口（nerdctl ps; echo $TOKEN）", () => {
		const plan = planInjection("nerdctl ps; echo $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("per-credential 段比对：引用段在管道后（消费段）命中仍放行（r8 #4 语义保持）", () => {
		const plan = planInjection("unrelated | nerdctl login $HARBOR_PASSWORD", PREFIXED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("2>&1 形态（review-high #1）：命中段的 2>&1 不影响放行；绕过形态的 2>&1 残段不产生伪命令词", () => {
		// 消费段命中 + 2>&1：放行不受 & 切分残段影响
		const ok = planInjection("nerdctl login $HARBOR_PASSWORD 2>&1", PREFIXED, {});
		expect(ok.block).toBeUndefined();
		expect(ok.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
		// 绕过形态 + 2>&1：残段纯数字伪词不参与判定、不混入报错文案
		const bad = planInjection("echo $HARBOR_PASSWORD 2>&1 | nerdctl ps", PREFIXED, {});
		expect(bad.block).toContain('当前命令词 "echo、nerdctl"'); // 残段 "1" 已剔除
	});
});

describe("planInjection：单引号内已存名引用 block（r5 #2/r6 #5 直调）", () => {
	const SEED: Store = { HARBOR_PASSWORD: ent("harbor-secret-value") };

	it("sudo sh -c 'echo $NAME' → block：单引号延迟展开 + sudo 清环境取空值照常执行（fail closed），提示改双引号", () => {
		const plan = planInjection("sudo sh -c 'echo $HARBOR_PASSWORD'", SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.block).toContain("双引号");
	});

	it("env -i sh -c 'echo $NAME' → block（清环境同缺口）", () => {
		const plan = planInjection("env -i sh -c 'echo $HARBOR_PASSWORD'", SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("双引号形态照常注入（外层展开，注入值对内层可达）：bash -c \"echo $NAME\" 不拦", () => {
		const plan = planInjection('bash -c "echo $HARBOR_PASSWORD"', SEED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("r6 #5：'\\'' 拼接形态与 commandContext 同源判定——拼接段内的已存名引用仍 block", () => {
		// 'echo ok'\''$NAME' ≡ echo ok'$NAME'：'\'' 拼接后的段仍在单引号内
		const plan = planInjection("sudo sh -c 'echo ok'\\''$HARBOR_PASSWORD'", SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("r6 #5：双引号内撇号不再误判单引号（近似 split 删除）——\"it's $NAME\" 照常注入", () => {
		const plan = planInjection(`bash -c "echo it's $HARBOR_PASSWORD"`, SEED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});
});

describe("planInjection：展开式引用命中已存名 block（r8 #3/r9 #1 直调）", () => {
	const SEED: Store = { HARBOR_PASSWORD: ent("harbor-secret-value") };

	it("${NAME:-def} 命中已存名 → block：展开式不注入真值（r1 #1），命令带空/默认值照常执行，与 r5 #2 同缺口 fail closed", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD:-default}"', SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.block).toContain("展开式");
		expect(plan.block).toContain("$HARBOR_PASSWORD"); // 改写指引（与 r5 #2 同文案族）
	});

	it("${NAME:?msg} 命中已存名 → block（同文案族）", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD:?missing}"', SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("r9 #1：纯展开+字面后缀（${NAME}/config、${NAME}-suffix）不判展开式——照常注入不 block", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD}/config" "${HARBOR_PASSWORD}-suffix"', SEED, {});
		expect(plan.block).toBeUndefined(); // 旧正则 [^}] 把 } 后的字面后缀误判为展开操作符 → 误 block（红）
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("r9 #1：纯 ${NAME} 花括号不因旧正则回溯截断误判展开式（存名与截断前缀名并存）", () => {
		const store: Store = {
			...SEED,
			HARBOR_PASSWOR: ent("prefix-value-9999"), // HARBOR_PASSWORD 截去末字符
		};
		const plan = planInjection('echo "${HARBOR_PASSWORD}"', store, {});
		// 旧正则 [^}] 回溯：${HARBOR_PASSWORD} → m[1]=HARBOR_PASSWOR（截断）命中已存名 → 纯花括号注入路径被误 block（红）
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("r9 #1 回归锁：${NAME:-def} 操作符形态仍判展开式 block（r8 #3 语义在收紧后保持）", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD:=d}"', SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("展开式引用未存名不拦（r1 #1 白名单语义）：命令逐字节原样", () => {
		const plan = planInjection('echo "${MISSING_VAR:-d}"', SEED, {});
		expect(plan).toEqual({});
	});

	it("混用：未存名展开式不影响已存名注入", () => {
		const plan = planInjection('echo "${MISSING_VAR:-d}" $HARBOR_PASSWORD', SEED, {});
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});
});

describe("planInjection：r10 #1 操作符锚定在 } 之内（rolling-review-r10 直调）", () => {
	const SEED: Store = { HARBOR_PASSWORD: ent("harbor-secret-value") };

	it("验收表·不 block：${NAME}+字面后缀（-suffix、/path、#x、?）逐形态不判展开式——走纯注入", () => {
		const plan = planInjection(
			'echo "${HARBOR_PASSWORD}-suffix" "${HARBOR_PASSWORD}/path" "${HARBOR_PASSWORD}#x" "${HARBOR_PASSWORD}?"',
			SEED,
			{},
		);
		expect(plan.block).toBeUndefined();
		expect(plan.assignments).toEqual(["HARBOR_PASSWORD='harbor-secret-value'"]);
	});

	it("验收表·不 block：未闭合花括号 ${NAME-suffix（bash bad substitution，命令本就不执行）不判展开式", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD-suffix', SEED, {});
		expect(plan).toEqual({});
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
	])("验收表·block：展开式 %s 命中已存名仍 block", (_label, cmd) => {
		const plan = planInjection(cmd, SEED, {});
		expect(plan.block).toContain("HARBOR_PASSWORD");
	});

	it("r9 语义回归锁：${NAME:0:3} 子串展开（冒号后接数字）仍放行——不判展开式不拦也不注入", () => {
		const plan = planInjection('echo "${HARBOR_PASSWORD:0:3}"', SEED, {});
		expect(plan).toEqual({});
	});
});

describe("planInjection：明文回填（#172，r3 #1 起替换仅限裸 token；直调）", () => {
	it("命令含已存明文（裸 token）→ text 改写为 $NAME，再走注入决策（对应 harness 端到端拼装冒烟）", () => {
		const store: Store = { A_TOKEN: ent("a-token-value-1") };
		const plan = planInjection("echo a-token-value-1", store, { A_TOKEN: "a-token-value-1" });
		expect(plan.block).toBeUndefined();
		expect(plan.text).toBe("echo $A_TOKEN");
		expect(plan.assignments).toEqual(["A_TOKEN='a-token-value-1'"]);
	});

	it("明文出现在命令中段/多值混排均替换（裸 token）；未命中 store 值的文本不进 text（不误伤）", () => {
		const store: Store = { A_TOKEN: ent("a-token-value-1"), B_TOKEN: ent("b-token-value-2") };
		const index = { A_TOKEN: "a-token-value-1", B_TOKEN: "b-token-value-2" };
		const plan = planInjection(`printf '%s' pre-a a-token-value-1 mid b-token-value-2 post`, store, index);
		expect(plan.text).toBe(`printf '%s' pre-a $A_TOKEN mid $B_TOKEN post`);
		const plain = planInjection("echo totally-unrelated-text", store, index);
		expect(plain).toEqual({});
	});

	it("同一明文对应多凭证名（防御形态，值唯一性由 store 保证）→ 取最长名替换", () => {
		const store: Store = { A_TOKEN: ent("same-secret-value-99"), LONGER_A_TOKEN: ent("same-secret-value-99") };
		const plan = planInjection("echo same-secret-value-99", store, { A_TOKEN: "same-secret-value-99", LONGER_A_TOKEN: "same-secret-value-99" });
		expect(plan.text).toBe("echo $LONGER_A_TOKEN");
		expect(plan.assignments).toEqual(["LONGER_A_TOKEN='same-secret-value-99'"]);
	});

	it("回填值含正则特殊字符（$ . ] [）：正确转义命中，替换后 shellQuote 逐字节还原", () => {
		const store: Store = { WEIRD: ent("p$ss.w0rd]x[9") };
		const plan = planInjection("echo p$ss.w0rd]x[9", store, { WEIRD: "p$ss.w0rd]x[9" });
		expect(plan.text).toBe("echo $WEIRD");
		expect(plan.assignments).toEqual(["WEIRD='p$ss.w0rd]x[9'"]);
	});

	it("回填产物走 allowedPrefix 决策：限定凭证明文写进不命中命令 → block（不因回填绕过限定），text 已无明文", () => {
		const store: Store = { HARBOR_PASSWORD: ent("harbor-secret-value", ["nerdctl"]) };
		const plan = planInjection("git push harbor-secret-value", store, { HARBOR_PASSWORD: "harbor-secret-value" });
		expect(plan.block).toContain("HARBOR_PASSWORD");
		expect(plan.text).toBe("git push $HARBOR_PASSWORD"); // 已回填为 $NAME（block 与 text 并存：现状语义，回填先于拦截判定）
	});

	it("forget 后旧值仍回填（[4] 累积语义显式化）：索引含旧值而快照无此名 → 改写不注入不报错", () => {
		const plan = planInjection("echo a-token-value-1", {}, { A_TOKEN: "a-token-value-1" });
		expect(plan.block).toBeUndefined();
		expect(plan.text).toBe("echo $A_TOKEN");
		expect(plan.assignments).toBeUndefined(); // 未存名静默跳过（语义锁③）
	});
});

describe("planInjection：数据位拦截（r3 #1/r7 #2 直调，引号字符串/heredoc/命令替换）", () => {
	const SEED: Store = { A_TOKEN: ent("a-token-value-1") };
	const INDEX = { A_TOKEN: "a-token-value-1" };

	it("引号字符串内命中（单引号）→ block 不改写：报错含凭证名/数据语义原因/$NAME 指引三要素", () => {
		const plan = planInjection("echo 'a-token-value-1'", SEED, INDEX);
		expect(plan.block).toContain("A_TOKEN");
		expect(plan.block).toContain("数据语义");
		expect(plan.block).toContain("$A_TOKEN");
		expect(plan.block).toContain("secret_query");
		expect(plan.text).toBeUndefined(); // 不改写
	});

	it("JSON payload/双引号字符串内命中 → block（静默改写会篡改数据语义）", () => {
		const store: Store = { A_TOKEN: ent("a-token-value-1"), B_TOKEN: ent("b-token-value-2") };
		const plan = planInjection(`printf '%s' "pre a-token-value-1 mid b-token-value-2 post"`, store, {
			A_TOKEN: "a-token-value-1",
			B_TOKEN: "b-token-value-2",
		});
		expect(plan.block).toContain("A_TOKEN");
		expect(plan.block).toContain("B_TOKEN");
		expect(plan.text).toBeUndefined();
	});

	it("heredoc 体命中 → block（heredoc 是数据位）", () => {
		const plan = planInjection("cat <<EOF\na-token-value-1\nEOF", SEED, INDEX);
		expect(plan.block).toContain("A_TOKEN");
		expect(plan.text).toBeUndefined();
	});

	it("命令替换体内命中 → block（r7 #2）：$( ) 与反引号体是数据位，不机械改写", () => {
		const sub = planInjection("curl $(echo a-token-value-1)", SEED, INDEX);
		expect(sub.block).toContain("A_TOKEN"); // 旧实现：$() 体当裸 token 机械替换，语义静默改变（红）
		expect(sub.text).toBeUndefined(); // 阻断不改写
		const bt = planInjection("echo `echo a-token-value-1`", SEED, INDEX);
		expect(bt.block).toContain("A_TOKEN");
		expect(bt.text).toBeUndefined();
	});

	it("r9 #4：$() 内嵌双引号含 ) —— 双引号内的 ) 不误减深度，其后替换体明文仍判数据位 block", () => {
		const plan = planInjection('curl $(echo "a)b" a-token-value-1)', SEED, INDEX);
		expect(plan.block).toContain("A_TOKEN"); // 旧实现：引号内 ) 误减深度 → 其后命中沦为裸 token 被机械改写（红）
		expect(plan.text).toBeUndefined(); // 阻断不改写
	});

	it("heredoc 结束后的命令位命中 → 正常裸 token 回填（heredoc 不吞后续命令）", () => {
		const plan = planInjection("cat <<'EOF'\ndoc-body\nEOF\necho a-token-value-1", SEED, INDEX);
		expect(plan.block).toBeUndefined();
		expect(plan.text).toBe("cat <<'EOF'\ndoc-body\nEOF\necho $A_TOKEN");
		expect(plan.assignments).toEqual(["A_TOKEN='a-token-value-1'"]);
	});
});

describe("planInjection：回填转义变体边界（r4 #5/r7 #5 直调；自 redact.test.ts harness 用例等价迁移）", () => {
	const INDEX = { MULTI: "line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret" };
	const MULTILINE_CMD = String.raw`echo line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret`;

	it("裸位命中 JSON 转义变体 → 原样保留（字面 \\n 非原始值形态，回填会篡改字面数据）", () => {
		const plan = planInjection(MULTILINE_CMD, {}, INDEX);
		expect(plan).toEqual({}); // red：会机械替换为 $MULTI 篡改字面量
	});

	it("转义变体数据位命中仍阻断（仅在数据位走 dataHits，不静默放行泄密载荷）", () => {
		const cmd = `curl -d '${String.raw`{"v":"line-one-of-multiline-secret-xx\nsecond-line-of-multiline-secret"}`}'`;
		const plan = planInjection(cmd, {}, INDEX);
		expect(plan.block).toContain("MULTI");
		expect(plan.text).toBeUndefined(); // 阻断不改写
	});

	it("转义变体跳过不吞重叠短值命中（r7 #5）：lastIndex 回退，短值照常回填", () => {
		const index = { MULTI: "ab\ncdef", PART: "ncdef" };
		const cmd = String.raw`echo ab\ncdef`; // 字面 \n：MULTI 转义变体裸位命中（不回填，r4 #5），重叠其内的 PART 裸值照常回填
		const plan = planInjection(cmd, { MULTI: ent("ab\ncdef"), PART: ent("ncdef") }, index);
		expect(plan.block).toBeUndefined();
		// 旧实现：g 正则消费转义变体后 continue，PART 在重叠起点的命中被吞（红）；MULTI 转义变体裸位不回填 → 无其引用
		expect(plan.text).toContain("$PART");
		expect(plan.assignments).toEqual(["PART='ncdef'"]);
	});
});

describe("hasInjectableRef：预判谓词（#179 零 I/O 直通公开面）", () => {
	it("无引用命令（裸文本）→ false；$NAME / ${NAME} 引用 → true；仅展开式形态 → true（需读快照判定）", () => {
		expect(hasInjectableRef("go build ./...")).toBe(false);
		expect(hasInjectableRef("echo plain text")).toBe(false);
		expect(hasInjectableRef('printf "%s" "$A_TOKEN"')).toBe(true);
		expect(hasInjectableRef("echo ${A_TOKEN}")).toBe(true);
		expect(hasInjectableRef('echo "${MISSING_VAR:-d}"')).toBe(true); // 展开式计入直通兴趣（未存名不拦，但要读快照判定）
	});
});

// review-high #4：commandContext 交叠/嵌套形态行为固化——锁当前行为防漂移（不论对错，已知不支持清单见
// lib/injection.ts commandContext 注释）。库级直调（#179 自 redact.test.ts 迁入：扫描器随模块搬家）；
// 位置索引显式标注便于对照。
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
		for (let i = 5; i <= 10; i++) expect(ctx[i]).toBe(IN_SUBST); // 5-10 = $((1+2
		expect(ctx[11]).toBe(0); // 11-12 = ))
		expect(ctx[12]).toBe(0);
	});

	it("process substitution <( )> 不跟踪：体内 | ; 落裸位（commandSegments 会当段边界，已知漂移）", () => {
		const cmd = "diff <(a|b) >(c;d)";
		const ctx = commandContext(cmd);
		for (let i = 0; i < cmd.length; i++) expect(ctx[i]).toBe(0);
	});
});
