/**
 * P1 凭证检测单测（fixture 移植自 ~/tmp/hook-mining/test-bash-guards.sh P1 段）。
 * 全 20 族 TOKEN_TABLE 各一例 block；白名单（$/{ 前缀、PLACEHOLDER）各一例 allow；报错文案契约。
 * exit 2 语义已换为 pi 原生 { block: true, reason }（经 tool_call 监听器驱动）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnv, runToolCall, setupHarness } from "./helpers.ts";

afterEach(cleanupEnv);

const GPVAL = "glpat-" + "a1B2c3D4e5F6g7H8i9J0";
const GPAb = "AbCdEfGhIjKlMnOpQrStUv";
const GLPAT21 = "glpat-" + "a1B2c3D4e5F6g7H8i9J0" + "k1";  // 测试样值：拼接构造，blob 无完整形态（GitHub GitLab 检测器）
/** 按 bash-guards.sh TOKEN_TABLE 形状构造各族的合法样值（占位段非 PLACEHOLDER 词）。 */
const WDUMMY = "glpat-" + "dummy".repeat(5);
const WEXAMPLE = "glpat-" + "example".repeat(4);
const WYOURTOKEN = "glpat-" + "your-token-" + "x".repeat(13);
const BLOCK_CASES: Array<[string, string, string]> = [
	["GitLab PAT", "glpat-" + "a1B2c3D4e5F6g7H8i9J0" + "k1", `curl -H 'Authorization: Bearer ${GLPAT21}' https://gitblue.example/api`],
	["GitLab CI job token", "glcbt-a1B2c3D4e5F6g7H8i9J0", "curl -H 'JOB-TOKEN: glcbt-a1B2c3D4e5F6g7H8i9J0' https://gitblue.example/api/v4/jobs"],
	["GitHub fine-grained PAT", "github_pat_a1B2c3D4e5F6g7H8i9J0k1", "git clone https://x:github_pat_a1B2c3D4e5F6g7H8i9J0k1@github.com/x/y"],
	["GitHub token", "ghp_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIj", "git clone https://ghp_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIj@github.com/x/y"],
	["Docker Hub PAT", "dckr_pat_AbCdEfGhIjKlMnOpQrSt", "docker login -u x -p dckr_pat_AbCdEfGhIjKlMnOpQrSt"],
	["HuggingFace token", "hf_QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHh0", "huggingface-cli login --token hf_QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHh0"],
	["Anthropic API key", "sk-ant-a1B2c3D4e5F6g7H8i9J0k1", "curl https://api.anthropic.com -H 'x-api-key: sk-ant-a1B2c3D4e5F6g7H8i9J0k1'"],
	["OpenAI API key", "sk-proj-a1B2c3D4e5F6g7H8i9J0k1", "curl https://api.openai.com -H 'Authorization: Bearer sk-proj-a1B2c3D4e5F6g7H8i9J0k1'"],
	["Groq API key", "gsk_AbCdEfGhIjKlMnOpQrStUv", "curl https://api.groq.com -H 'Authorization: Bearer gsk_AbCdEfGhIjKlMnOpQrStUv'"],
	["LLM provider API key (DeepSeek/Moonshot/…)", "sk-QqWwEeRrTtYyUuIiOoPp", "curl https://api.deepseek.com/v1 -H 'Authorization: Bearer sk-QqWwEeRrTtYyUuIiOoPp'"],
	["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "curl 'https://maps.googleapis.com/maps/api/geocode/json?address=x&key=AIzaSyA1234567890abcdefghijklmnopqrstuv'"],
	["AWS access key", "AKIAIOSFODNN7ZXTSTQX", "aws s3 ls --region us-east-1 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7ZXTSTQX"],
	["Alibaba Cloud AccessKey", "LTAI5tAbCdEfGhIjKlMnOp", "ossutil ls -i LTAI5tAbCdEfGhIjKlMnOp -k secret"],
	["Slack token", "xoxb-123456789012-AbCdEfGhIjKl", "curl -d 'token=xoxb-123456789012-AbCdEfGhIjKl' https://slack.com/api/auth.test"],
	["DigitalOcean token", "doo_v1_" + "a1b2c3d4".repeat(15), "doctl auth init -t " + "doo_v1_" + "a1b2c3d4".repeat(15)],
	["npm access token", "npm_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIj", "echo //registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIj > ~/.npmrc"],
	["PyPI upload token", "pypi-a1B2c3D4e5F6g7H8i9J0k1", "twine upload -u __token__ -p pypi-a1B2c3D4e5F6g7H8i9J0k1 dist/*"],
	["Linear API key", "lin_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "curl -H 'Authorization: lin_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' https://api.linear.app/graphql"],
	["PlanetScale credential", "pscale_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "pscale password create db branch main --token pscale_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0x"],
	["Replicate API token", "r8_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIjKlMn", "replicate predict -t r8_AbCdEfGhIjKlMnOpQrStUvwxYzAbCdEfGhIjKlMn"],
];

describe("P1：TOKEN_TABLE 20 族全拦截", () => {
	it.each(BLOCK_CASES)("%s → block 且文案含平台名/指纹前 8 字符/secret_ensure 互指", async (platform, value, command) => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, command);
		expect(result?.block, `${platform} should block`).toBe(true);
		expect(result?.reason).toContain(platform);
		expect(result?.reason).toContain(value.slice(0, 8));
		expect(result?.reason).toContain("secret_ensure");
		expect(result?.reason).toContain("$NAME");
	});
});

describe("P1：白名单放行", () => {
	// 词表占位样值：拼接构造（GitHub GitLab 检测器不拦 blob；本地断言白名单放行语义）
			const ALLOW_CASES: Array<[string, string]> = [
		["家族命中但 $ 前缀", `curl -H "Authorization: Bearer $glpat-${GPVAL}" https://x`],
		["$VAR 引用（不构成家族形状，fixture 同款）", 'curl -H "Authorization: Bearer $GLAB_TOKEN" https://gitblue.example/api'],
		["${NAME} 引用形态（裸 { 前缀已收窄，不再豁免）", `echo "\${glpat-${GPVAL}}"`],
		["dummy 占位值", `curl -H 'Authorization: Bearer ${WDUMMY}' https://x`],
		["example 占位值（gitleaks 文档样例）", "echo AKIAIOSFODNN7EXAMPLE"],
		["xxxxx placeholder", "curl -H 'JOB-TOKEN: glcbt-xxxxx1234567890abcdef' https://gitblue.example/api/v4/jobs"],
		["your-token 占位值", `curl -H 'Authorization: Bearer ${WYOURTOKEN}' https://x`],
		["fake 占位值", "ossutil ls -i LTAIfakefakefakefakefake -k secret"],
		["sample 占位值", "curl -H 'Authorization: Bearer gsk_samplesamplesamplesample' https://x"],
		["redacted 占位值", "curl https://api.anthropic.com -H 'x-api-key: sk-ant-redacted-xxxxxxxxxxxxxxxxxx'"],
		["非凭证形状", "glab mr view 123"],
		["短 sk-（不构成 key）", "echo sk-short"],
	];

	it.each(ALLOW_CASES)("%s → 不拦", async (_label, command) => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, command);
		expect(result, `${command} should pass P1`).toBeUndefined();
	});
});

describe("P1：检测边界回归（rolling-review-r1 批 B 修复）", () => {
	it("[9] 同族首个占位命中不抑制后续真 token（逐 match 判定）", async () => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, `echo ${WEXAMPLE} ${GLPAT21}`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("GitLab PAT");
		expect(result?.reason).toContain("glpat-a1"); // 报的是第二个真 token，非占位值
	});

	it("[10] 裸 { 前缀不再豁免（{ 前无 $ 即字面量）", async () => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, `printf '%s' '{glpat-${GPAb}}'`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("GitLab PAT");
	});
});

describe("P1：注入前缀互操作（检测先于注入，看到的是原始命令）", () => {
	// 注：bash-guards fixture 的 "prefix + $NAME 放行" 案不移植——hook 每次执行重入所以看得到前缀，
	// 扩展内 P1/guard 先于注入执行、前缀永不重入（#126 冒烟确认 transcript 形态）。
	it("已带注入前缀的命令内含明文 glpat → 仍 block（前缀不影响检测，无需剥离）", async () => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, `: __PI_SECRET_STORE__; curl -H 'Authorization: Bearer glpat-${GPAb}' https://x`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("GitLab PAT"); // P1 reason（先于 guard/注入）
	});

	it("transcript 回贴场景：命令字面 source 真 env 路径 → guard 拦（引号内明文路径即读存储文件）", async () => {
		const h = await setupHarness();
		const { result } = await runToolCall(h, `: __PI_SECRET_STORE__; if [ -f "${h.envFile}" ]; then set -a; . "${h.envFile}" 2>/dev/null; set +a; fi; curl -H "Authorization: Bearer $GITBLUE_TOKEN" https://x`);
		expect(result?.block).toBe(true);
	});
});
