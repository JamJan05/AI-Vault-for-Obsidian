/**
 * The migration into SecretStorage is the one piece of code that could lose a
 * user's API keys. It must never report success for a key it did not store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_SECRET_ID,
	isSecretBackend,
	isValidSecretId,
	migrateKeysToSecrets,
	resolveKeys,
} from "../../src/security/keyStore";
import type { SecretBackend } from "../../src/security/keyStore";

class FakeStore implements SecretBackend {
	readonly data = new Map<string, string>();
	writes = 0;

	getSecret(id: string): string | null {
		return this.data.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid id");
		this.writes++;
		this.data.set(id, secret);
	}
}

const NO_NAMES = { apiKey: "", claudeApiKey: "", localApiKey: "" };

describe("isValidSecretId", () => {
	it("accepts lowercase letters, digits and dashes", () => {
		for (const id of ["a", "ai-vault-openai-api-key", "key-2", "abc123"]) {
			assert.equal(isValidSecretId(id), true, id);
		}
	});

	it("rejects everything else", () => {
		for (const id of ["", "Upper", "with space", "under_score", "-lead", "trail-", "a--b", "ł", "a/b", "x".repeat(65), null, undefined, 5]) {
			assert.equal(isValidSecretId(id), false, String(id));
		}
	});

	it("accepts every default name", () => {
		for (const id of Object.values(DEFAULT_SECRET_ID)) assert.equal(isValidSecretId(id), true, id);
	});
});

describe("isSecretBackend", () => {
	it("recognizes an object with both methods", () => {
		assert.equal(isSecretBackend(new FakeStore()), true);
	});

	it("rejects anything incomplete", () => {
		for (const bad of [null, undefined, {}, { getSecret: () => null }, { setSecret: 1, getSecret: () => null }, "x"]) {
			assert.equal(isSecretBackend(bad), false);
		}
	});
});

describe("migrateKeysToSecrets", () => {
	it("stores each key under its default name", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets(
			{ apiKey: "sk-openai", claudeApiKey: "sk-ant-claude", localApiKey: "local" },
			NO_NAMES,
			store,
		);

		assert.deepEqual(result.failed, []);
		assert.deepEqual(result.migrated, ["apiKey", "claudeApiKey", "localApiKey"]);
		assert.equal(store.getSecret(result.names.apiKey), "sk-openai");
		assert.equal(store.getSecret(result.names.claudeApiKey), "sk-ant-claude");
		assert.equal(store.getSecret(result.names.localApiKey), "local");
		assert.equal(result.names.apiKey, DEFAULT_SECRET_ID.apiKey);
	});

	it("skips keys that are empty", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets({ apiKey: "sk-openai", claudeApiKey: "", localApiKey: "   " }, NO_NAMES, store);
		assert.deepEqual(result.migrated, ["apiKey"]);
		assert.equal(result.names.claudeApiKey, "");
		assert.equal(result.names.localApiKey, "");
		assert.equal(store.data.size, 1);
	});

	it("trims the key before storing it", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets({ apiKey: "  sk-openai \n" }, NO_NAMES, store);
		assert.equal(store.getSecret(result.names.apiKey), "sk-openai");
	});

	it("does nothing when the secret already holds the key", () => {
		const store = new FakeStore();
		store.data.set("my-key", "sk-openai");
		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, { ...NO_NAMES, apiKey: "my-key" }, store);
		assert.deepEqual(result.migrated, []);
		assert.deepEqual(result.failed, []);
		assert.equal(result.names.apiKey, "my-key");
		assert.equal(store.writes, 0);
	});

	it("updates the named secret when the plaintext key is different", () => {
		const store = new FakeStore();
		store.data.set("my-key", "sk-old");
		const result = migrateKeysToSecrets({ apiKey: "sk-new" }, { ...NO_NAMES, apiKey: "my-key" }, store);
		assert.deepEqual(result.migrated, ["apiKey"]);
		assert.equal(store.getSecret("my-key"), "sk-new");
	});

	it("never overwrites a secret that belongs to something else", () => {
		const store = new FakeStore();
		store.data.set(DEFAULT_SECRET_ID.apiKey, "someone-elses-value");

		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, NO_NAMES, store);
		assert.equal(store.getSecret(DEFAULT_SECRET_ID.apiKey), "someone-elses-value");
		assert.equal(result.names.apiKey, `${DEFAULT_SECRET_ID.apiKey}-2`);
		assert.equal(store.getSecret(result.names.apiKey), "sk-openai");
	});

	it("ignores a stored name that is not a valid id", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, { ...NO_NAMES, apiKey: "Not Valid!" }, store);
		assert.equal(result.names.apiKey, DEFAULT_SECRET_ID.apiKey);
		assert.deepEqual(result.failed, []);
	});

	it("reports a failure when the store throws", () => {
		const store: SecretBackend = {
			getSecret: () => null,
			setSecret: () => { throw new Error("storage unavailable"); },
		};
		const result = migrateKeysToSecrets({ apiKey: "sk-openai", claudeApiKey: "sk-ant" }, NO_NAMES, store);
		assert.deepEqual(result.failed, ["apiKey", "claudeApiKey"]);
		assert.deepEqual(result.migrated, []);
		assert.equal(result.names.apiKey, "");
	});

	it("reports a failure when the value does not read back", () => {
		const store: SecretBackend = { getSecret: () => null, setSecret: () => { /* silently drops it */ } };
		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, NO_NAMES, store);
		assert.deepEqual(result.failed, ["apiKey"]);
	});

	it("reports a failure when the store returns a different value", () => {
		const store: SecretBackend = { getSecret: () => "truncated", setSecret: () => { /* corrupts it */ } };
		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, { ...NO_NAMES, apiKey: "my-key" }, store);
		assert.deepEqual(result.failed, ["apiKey"]);
	});

	it("survives a store whose reads throw", () => {
		const store: SecretBackend = {
			getSecret: () => { throw new Error("locked"); },
			setSecret: () => { /* accepted, but cannot be verified */ },
		};
		const result = migrateKeysToSecrets({ apiKey: "sk-openai" }, NO_NAMES, store);
		assert.deepEqual(result.failed, ["apiKey"]);
	});

	it("reports each key on its own", () => {
		const good = new FakeStore();
		const store: SecretBackend = {
			getSecret: id => good.getSecret(id),
			setSecret: (id, value) => {
				if (id.includes("anthropic")) throw new Error("nope");
				good.setSecret(id, value);
			},
		};
		const result = migrateKeysToSecrets({ apiKey: "a", claudeApiKey: "b", localApiKey: "c" }, NO_NAMES, store);
		assert.deepEqual(result.migrated, ["apiKey", "localApiKey"]);
		assert.deepEqual(result.failed, ["claudeApiKey"]);
	});

	it("never puts a key into an error or a result field other than the store", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets({ apiKey: "sk-VERY-SECRET" }, NO_NAMES, store);
		assert.equal(JSON.stringify(result).includes("sk-VERY-SECRET"), false);
	});

	it("tolerates missing and mistyped input", () => {
		const store = new FakeStore();
		const result = migrateKeysToSecrets(
			{ apiKey: 42 as unknown as string },
			{ apiKey: null as unknown as string },
			store,
		);
		assert.deepEqual(result.migrated, []);
		assert.deepEqual(result.failed, []);
	});
});

describe("resolveKeys", () => {
	it("reads the key behind each name", () => {
		const store = new FakeStore();
		store.data.set("openai", "sk-openai");
		store.data.set("claude", " sk-ant \n");
		const keys = resolveKeys({ apiKey: "openai", claudeApiKey: "claude", localApiKey: "" }, store);
		assert.deepEqual(keys, { apiKey: "sk-openai", claudeApiKey: "sk-ant", localApiKey: "" });
	});

	it("returns an empty key for a missing secret or an invalid name", () => {
		const store = new FakeStore();
		const keys = resolveKeys({ apiKey: "gone", claudeApiKey: "Not Valid!", localApiKey: undefined as unknown as string }, store);
		assert.deepEqual(keys, { apiKey: "", claudeApiKey: "", localApiKey: "" });
	});

	it("returns an empty key when the store throws", () => {
		const store: SecretBackend = { getSecret: () => { throw new Error("locked"); }, setSecret: () => { /* unused */ } };
		assert.deepEqual(resolveKeys({ apiKey: "openai" }, store), { apiKey: "", claudeApiKey: "", localApiKey: "" });
	});

	it("round-trips with the migration", () => {
		const store = new FakeStore();
		const keys = { apiKey: "sk-openai", claudeApiKey: "sk-ant", localApiKey: "local" };
		const { names } = migrateKeysToSecrets(keys, NO_NAMES, store);
		assert.deepEqual(resolveKeys(names, store), keys);
	});
});
