import { describe, it, expect } from "vitest";
import { parseEntityRef } from "./entity.ts";

describe("EntityRef key 前缀规范（ADR 0002：agent 不铸造不解析）", () => {
	it("接受三个正典前缀，key 原样通过——不规范化、不铸造（identity 解析归 profile key generator）", () => {
		const keys = [
			"external/docker://registry.example/img@sha256:aa92",
			"project/https://gitlab.example/group/pipe/-/merge_requests/42",
			"user//mnt/disk1/hyx/projects/pi-mypackage",
		];
		for (const key of keys) expect(parseEntityRef(key)).toBe(key);
	});

	it("拒绝未知前缀、无前缀、空 key，错误信息列封闭前缀集", () => {
		for (const bad of ["gitlab/mr!1", "mr-24248", "external/", ""]) {
			expect(() => parseEntityRef(bad)).toThrow(/EntityRef/);
		}
		expect(() => parseEntityRef("gitlab/mr!1")).toThrow(/project/);
	});
});
