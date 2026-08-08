import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isPathInside,
	isUnsafePathSegment,
	normalizeResolved,
	safeJoinInside,
	toPosixPath,
} from "../../src/security/paths";

const NUL = String.fromCharCode(0x00);

describe("isUnsafePathSegment", () => {
	it("accepts ordinary file and folder names", () => {
		for (const segment of ["keys.json", "history", "session-1700000000000.json", "rag-index.json"]) {
			assert.equal(isUnsafePathSegment(segment), false, `${segment} should be allowed`);
		}
	});

	it("rejects parent-directory traversal in any position", () => {
		for (const segment of ["..", "../keys.json", "history/../../keys.json", "a/../../b"]) {
			assert.equal(isUnsafePathSegment(segment), true, `${segment} must be rejected`);
		}
	});

	it("rejects traversal written with backslashes", () => {
		assert.equal(isUnsafePathSegment("..\\..\\keys.json"), true);
		assert.equal(isUnsafePathSegment("history\\..\\..\\etc"), true);
	});

	it("rejects absolute paths, UNC paths and drive letters", () => {
		assert.equal(isUnsafePathSegment("/etc/passwd"), true);
		assert.equal(isUnsafePathSegment("//server/share"), true);
		assert.equal(isUnsafePathSegment("C:/Windows/System32"), true);
		assert.equal(isUnsafePathSegment("c:keys.json"), true);
	});

	it("rejects NUL bytes and empty segments", () => {
		assert.equal(isUnsafePathSegment(`keys.json${NUL}.txt`), true);
		assert.equal(isUnsafePathSegment(""), true);
		assert.equal(isUnsafePathSegment(undefined as unknown as string), true);
	});

	it("rejects a bare current-directory segment", () => {
		assert.equal(isUnsafePathSegment("."), true);
		assert.equal(isUnsafePathSegment("./keys.json"), true);
	});
});

describe("normalizeResolved", () => {
	it("resolves . and .. without touching the file system", () => {
		assert.equal(normalizeResolved("/data/vault-gpt-data/history/../keys.json"), "/data/vault-gpt-data/keys.json");
		assert.equal(normalizeResolved("/data/./a//b/"), "/data/a/b");
	});

	it("keeps leading .. on a relative path so the escape stays visible", () => {
		assert.equal(normalizeResolved("../outside"), "../outside");
	});

	it("does not let .. climb above an absolute root", () => {
		assert.equal(normalizeResolved("/a/../../../etc"), "/etc");
	});

	it("normalizes Windows separators and keeps the drive", () => {
		assert.equal(normalizeResolved("C:\\data\\vault\\..\\keys.json"), "c:/data/keys.json");
	});
});

describe("isPathInside", () => {
	const base = "/home/u/vault-gpt-data";

	it("accepts the base itself and everything under it", () => {
		assert.equal(isPathInside(base, base), true);
		assert.equal(isPathInside(base, `${base}/keys.json`), true);
		assert.equal(isPathInside(base, `${base}/history/session-1.json`), true);
	});

	it("rejects a sibling directory with a shared prefix", () => {
		// The classic prefix bug: "…-gpt-data-evil" starts with the base string.
		assert.equal(isPathInside(base, "/home/u/vault-gpt-data-evil/keys.json"), false);
	});

	it("rejects anything the traversal resolves outside the base", () => {
		assert.equal(isPathInside(base, `${base}/../../.ssh/id_rsa`), false);
		assert.equal(isPathInside(base, "/etc/passwd"), false);
	});

	it("compares case-insensitively for Windows-style paths", () => {
		assert.equal(isPathInside("C:/Data/AiVault", "c:/data/aivault/keys.json"), true);
	});
});

describe("safeJoinInside", () => {
	const base = "/home/u/vault-gpt-data";

	it("joins ordinary segments", () => {
		assert.equal(safeJoinInside(base, "keys.json"), `${base}/keys.json`);
		assert.equal(safeJoinInside(base, "history", "session-1.json"), `${base}/history/session-1.json`);
	});

	it("returns null — never the base — for a traversal attempt", () => {
		assert.equal(safeJoinInside(base, "..", "keys.json"), null);
		assert.equal(safeJoinInside(base, "../../.ssh/id_rsa"), null);
		assert.equal(safeJoinInside(base, "/etc/passwd"), null);
		assert.equal(safeJoinInside(base, `evil${NUL}.json`), null);
	});

	it("returns null when there is no base", () => {
		assert.equal(safeJoinInside("", "keys.json"), null);
	});
});

describe("toPosixPath", () => {
	it("unifies separators and collapses duplicates", () => {
		assert.equal(toPosixPath("a\\\\b//c"), "a/b/c");
	});
});
