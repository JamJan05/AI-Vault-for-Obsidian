import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PluginStorage } from "../../src/storage/PluginStorage";

const BASE = ".obsidian/plugins/ai-vault";

interface Call {
	op:   string;
	path: string;
	data?: string;
	to?:  string;
}

/**
 * Minimal DataAdapter stand-in that records every call, so a test can assert
 * not only what PluginStorage returned but whether it touched the vault at all.
 */
class FakeAdapter {
	readonly calls: Call[] = [];
	readonly files = new Map<string, string>();

	/** When set, `rename` throws — the platforms where the atomic path is unavailable. */
	renameFails = false;

	async exists(path: string): Promise<boolean> {
		this.calls.push({ op: "exists", path });
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		this.calls.push({ op: "read", path });
		const value = this.files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		return value;
	}

	async write(path: string, data: string): Promise<void> {
		this.calls.push({ op: "write", path, data });
		this.files.set(path, data);
	}

	async rename(path: string, to: string): Promise<void> {
		this.calls.push({ op: "rename", path, to });
		if (this.renameFails) throw new Error("EEXIST");
		const value = this.files.get(path);
		if (value === undefined) throw new Error("ENOENT");
		this.files.delete(path);
		this.files.set(to, value);
	}

	async remove(path: string): Promise<void> {
		this.calls.push({ op: "remove", path });
		this.files.delete(path);
	}

	async mkdir(path: string): Promise<void> {
		this.calls.push({ op: "mkdir", path });
	}

	async rmdir(path: string, recursive: boolean): Promise<void> {
		this.calls.push({ op: "rmdir", path: `${path}:${recursive}` });
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		this.calls.push({ op: "list", path });
		return { files: [...this.files.keys()], folders: [] };
	}

	/** Calls that would have reached a file, ignoring pure lookups. */
	get mutations(): Call[] {
		return this.calls.filter(c => c.op !== "exists" && c.op !== "list");
	}
}

function makeStorage(): { storage: PluginStorage; adapter: FakeAdapter } {
	const adapter = new FakeAdapter();
	const plugin = {
		app:      { vault: { adapter, configDir: ".obsidian" } },
		manifest: { dir: BASE, id: "ai-vault" },
	};
	// The fake stands in for the Obsidian runtime, which is not importable in tests.
	const storage = new PluginStorage(plugin as unknown as import("obsidian").Plugin);
	return { storage, adapter };
}

/** Paths that must never reach the adapter, whatever the caller intended. */
const OUTSIDE_BASE = [
	"Notes/secret.md",
	".obsidian/plugins/other-plugin/data.json",
	`${BASE}/../../../etc/passwd`,
	`${BASE}/../other-plugin/data.json`,
	"/etc/passwd",
	"",
];

describe("PluginStorage — path containment", () => {
	it("resolves plugin paths under the plugin directory", () => {
		const { storage } = makeStorage();
		assert.equal(storage.resolve("history-index.json"), `${BASE}/history-index.json`);
		assert.equal(storage.resolve("history", "session-1.json"), `${BASE}/history/session-1.json`);
	});

	it("falls back to configDir when the manifest has no dir", () => {
		const adapter = new FakeAdapter();
		const plugin = {
			app:      { vault: { adapter, configDir: ".obsidian" } },
			manifest: { id: "ai-vault" },
		};
		const storage = new PluginStorage(plugin as unknown as import("obsidian").Plugin);
		assert.equal(storage.baseDir, BASE);
	});

	it("refuses to write outside the plugin directory", async () => {
		for (const path of OUTSIDE_BASE) {
			const { storage, adapter } = makeStorage();
			const ok = await storage.writeJson(path, { hijacked: true });
			assert.equal(ok, false, `${path} should be refused`);
			assert.deepEqual(adapter.mutations, [], `${path} must not reach the adapter`);
		}
	});

	it("refuses to read, delete or list outside the plugin directory", async () => {
		for (const path of OUTSIDE_BASE) {
			const { storage, adapter } = makeStorage();

			assert.equal(await storage.exists(path), false);
			assert.deepEqual(await storage.readJson(path, "fallback"), "fallback");
			assert.deepEqual(await storage.list(path), { files: [], folders: [] });
			await storage.remove(path);
			await storage.removeDir(path);
			await storage.ensureDir(path);

			assert.deepEqual(adapter.mutations, [], `${path} must not reach the adapter`);
		}
	});

	it("allows the base directory itself", async () => {
		const { storage, adapter } = makeStorage();
		await storage.ensureDir(BASE);
		assert.deepEqual(adapter.mutations, [{ op: "mkdir", path: BASE }]);
	});

	it("refuses a sibling directory whose name starts with the base", async () => {
		const { storage, adapter } = makeStorage();
		const ok = await storage.writeJson(`${BASE}-evil/data.json`, {});
		assert.equal(ok, false);
		assert.deepEqual(adapter.mutations, []);
	});
});

describe("PluginStorage — atomic writes", () => {
	it("writes through a temp file and renames it into place", async () => {
		const { storage, adapter } = makeStorage();
		const path = storage.resolve("history-index.json");

		assert.equal(await storage.writeJson(path, { a: 1 }), true);

		assert.deepEqual(adapter.mutations, [
			{ op: "mkdir", path: BASE },
			{ op: "write", path: `${path}.tmp`, data: '{"a":1}' },
			{ op: "rename", path: `${path}.tmp`, to: path },
		]);
		assert.equal(adapter.files.get(path), '{"a":1}');
		assert.equal(adapter.files.has(`${path}.tmp`), false);
	});

	it("never leaves a partial file when rename is unsupported", async () => {
		const { storage, adapter } = makeStorage();
		const path = storage.resolve("history-index.json");
		adapter.renameFails = true;

		assert.equal(await storage.writeJson(path, { a: 1 }), true);

		assert.equal(adapter.files.get(path), '{"a":1}', "the update must still land");
		assert.equal(adapter.files.has(`${path}.tmp`), false, "the temp file must be cleaned up");
	});

	it("round-trips through readJson", async () => {
		const { storage } = makeStorage();
		const path = storage.resolve("projects.json");

		await storage.writeJson(path, [{ id: "p1" }]);
		assert.deepEqual(await storage.readJson(path, []), [{ id: "p1" }]);
	});

	it("returns the fallback for a missing or corrupted file", async () => {
		const { storage, adapter } = makeStorage();
		const path = storage.resolve("rag-index.json");

		assert.deepEqual(await storage.readJson(path, "missing"), "missing");

		adapter.files.set(path, "{ not json");
		assert.deepEqual(await storage.readJson(path, "corrupt"), "corrupt");
	});
});
