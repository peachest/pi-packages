/**
 * P1 凭证检测（迁自 ~/.pi/agent/kendex/hooks/bash-guards.sh P1 段，2026-10-20 leader 拍板方案 A）。
 * TOKEN_TABLE 20 族：gitleaks 8.24.3 默认规则前缀 + LTAI（Alibaba）。
 * 白名单：shell 变量引用（$TOKEN / ${TOKEN} 形态，裸 { 前缀不豁免）与 PLACEHOLDER 占位值——指纹级检测，
 * 族内逐 match 判定（占位/引用只豁免单个 match，不抑制同族后续真 token），不做泛 password=/token= 形状（误报源）。
 * bash-guards.sh 的 marker 剥离逻辑不迁移：扩展内检测先于 env 注入执行，看到的总是原始命令。
 */
export interface TokenFinding {
	platform: string;
	value: string;
	rotateUrl: string;
}

const TOKEN_TABLE: ReadonlyArray<readonly [pattern: RegExp, platform: string, rotateUrl: string]> = [
	[/glpat-[A-Za-z0-9_-]{20,}/, "GitLab PAT", "https://gitlab.blue.example/-/profile/personal_access_tokens"],
	[/glcbt-[A-Za-z0-9_]{20,}/, "GitLab CI job token", "https://gitlab.blue.example/-/profile/personal_access_tokens"],
	[/github_pat_[A-Za-z0-9_]{22,}/, "GitHub fine-grained PAT", "https://github.com/settings/tokens"],
	[/gh[posur]_[A-Za-z0-9]{36}/, "GitHub token", "https://github.com/settings/tokens"],
	[/dckr_pat_[A-Za-z0-9_-]{20,}/, "Docker Hub PAT", "https://hub.docker.com/settings/security"],
	[/hf_[A-Za-z0-9]{30,}/, "HuggingFace token", "https://huggingface.co/settings/tokens"],
	[/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key", "https://console.anthropic.com/settings/keys"],
	[/sk-proj-[A-Za-z0-9_-]{20,}|sk-svcacct-[A-Za-z0-9_-]{20,}/, "OpenAI API key", "https://platform.openai.com/api-keys"],
	[/gsk_[A-Za-z0-9]{20,}/, "Groq API key", "https://console.groq.com/keys"],
	[/\bsk-[A-Za-z0-9]{20,}\b/, "LLM provider API key (DeepSeek/Moonshot/…)", "the provider's console"],
	[/AIza[0-9A-Za-z_-]{35}/, "Google API key", "https://console.cloud.google.com/apis/credentials"],
	[/A(S|K)IA[0-9A-Z]{16}/, "AWS access key", "https://console.aws.amazon.com/iam/home#/security_credentials"],
	[/LTAI[0-9A-Za-z]{16,24}/, "Alibaba Cloud AccessKey", "https://ram.console.aliyun.com/manage/ak"],
	[/xox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token", "https://api.slack.com/authentication/token-types"],
	[/do[op]_v1_[a-f0-9]{60,}/, "DigitalOcean token", "https://cloud.digitalocean.com/account/api/tokens"],
	[/npm_[A-Za-z0-9]{36}/, "npm access token", "https://www.npmjs.com/settings/-/tokens"],
	[/pypi-[A-Za-z0-9_-]{20,}/, "PyPI upload token", "https://pypi.org/manage/account/token/"],
	[/lin_[a-z0-9]{40}/, "Linear API key", "https://linear.app/settings/api"],
	[/pscale_[a-z0-9_]{40,}/, "PlanetScale credential", "https://app.planetscale.com/settings"],
	[/r8_[A-Za-z0-9]{40}/, "Replicate API token", "https://replicate.com/account/api-tokens"],
];

const PLACEHOLDER = /(dummy|fake|example|sample|placeholder|your[-_]?token|your[-_]?key|xxxxx|<token>|<key>|redacted)/i;

/** 返回第一个命中的凭证指纹（表序）；族内逐 match 判定白名单，全族豁免才向下一族找；无命中返回 undefined。 */
export function detectTokens(command: string): TokenFinding | undefined {
	for (const [pattern, platform, rotateUrl] of TOKEN_TABLE) {
		const global = new RegExp(pattern.source, pattern.flags + "g");
		let m: RegExpExecArray | null;
		while ((m = global.exec(command)) !== null) {
			const value = m[0];
			const before = command.slice(Math.max(0, m.index - 1), m.index);
			if (before === "$" || (before === "{" && command[m.index - 2] === "$")) continue; // $TOKEN / ${TOKEN} 变量引用，非字面量；裸 { 前缀是字面量
			if (PLACEHOLDER.test(value)) continue; // 占位值
			return { platform, value, rotateUrl };
		}
	}
	return undefined;
}

/** 报错文案：照抄 bash-guards.sh P1 现文案（平台名+指纹前 8 字符+轮换 URL+secret_ensure 互指）。 */
export function p1BlockReason(f: TokenFinding): string {
	return (
		`possible ${f.platform} written inline in the command (matches ${f.value.slice(0, 8)}…). ` +
		`Secrets must never appear in command text — they land in shell history and session logs. ` +
		`Reference it indirectly instead: put it in a gitignored file / env var and use $VAR, ` +
		`or for GitLab use $(glab config get token); if the pi-secret-store extension is installed, ` +
		`store it once via secret_ensure and reference $NAME. ` +
		`If a real secret leaked here, rotate it now at ${f.rotateUrl}.`
	);
}
