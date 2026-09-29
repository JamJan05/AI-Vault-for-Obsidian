/**
 * Moving API keys into Obsidian's SecretStorage.
 *
 * Settings hold the NAME of a secret; the value lives in SecretStorage, on the
 * device, outside data.json and outside Obsidian Sync. SecretStorage arrived in
 * Obsidian 1.11.4, so on older versions the plugin keeps its own key file.
 *
 * Free of Obsidian imports: the storage is passed in, so the migration — the one
 * piece of code that could lose a user's keys — is unit tested against a fake.
 */

export type KeyField = "apiKey" | "claudeApiKey" | "localApiKey";
export type SecretNameField = "openaiSecretName" | "claudeSecretName" | "localSecretName";

export const KEY_FIELDS: readonly KeyField[] = ["apiKey", "claudeApiKey", "localApiKey"];

export const SECRET_NAME_FIELD: Readonly<Record<KeyField, SecretNameField>> = {
	apiKey:       "openaiSecretName",
	claudeApiKey: "claudeSecretName",
	localApiKey:  "localSecretName",
};

/** Names the plugin gives the secrets it creates. */
export const DEFAULT_SECRET_ID: Readonly<Record<KeyField, string>> = {
	apiKey:       "ai-vault-openai-api-key",
	claudeApiKey: "ai-vault-anthropic-api-key",
	localApiKey:  "ai-vault-local-api-key",
};

export const SECRET_STORAGE_MIN_VERSION = "1.11.4";

/** The part of Obsidian's SecretStorage the plugin relies on. */
export interface SecretBackend {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export type KeyValues   = Record<KeyField, string>;
export type SecretNames = Record<KeyField, string>;

export interface MigrationResult {
	/** Secret name per key, including the ones that already had a name. */
	names:    SecretNames;
	/** Keys written to SecretStorage by this call. */
	migrated: KeyField[];
	/** Keys that could not be stored. When this is not empty, nothing may be deleted. */
	failed:   KeyField[];
}

/** SecretStorage accepts lowercase letters, digits and dashes. */
export function isValidSecretId(id: unknown): id is string {
	return typeof id === "string" && id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function isSecretBackend(value: unknown): value is SecretBackend {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.getSecret === "function" && typeof candidate.setSecret === "function";
}

function readSecret(backend: SecretBackend, id: string): string | null {
	try {
		const value = backend.getSecret(id);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

/**
 * A free secret name for a key. The store is shared with other plugins, so a name
 * that is taken by a different value is left alone and a numbered one is used.
 */
function pickSecretId(backend: SecretBackend, field: KeyField, value: string): string | null {
	const base = DEFAULT_SECRET_ID[field];
	for (let n = 1; n <= 20; n++) {
		const id = n === 1 ? base : `${base}-${n}`;
		const existing = readSecret(backend, id);
		if (existing === null || existing === "" || existing === value) return id;
	}
	return null;
}

/** Writes one secret and reads it back. True only when the stored value matches. */
function storeVerified(backend: SecretBackend, id: string, value: string): boolean {
	try {
		backend.setSecret(id, value);
	} catch {
		return false;
	}
	return readSecret(backend, id) === value;
}

/**
 * Stores every plaintext key in SecretStorage and verifies each one by reading it
 * back. Nothing is deleted here: the caller removes the plaintext copies only
 * when `failed` is empty.
 */
export function migrateKeysToSecrets(
	keys:    Partial<KeyValues>,
	names:   Partial<SecretNames>,
	backend: SecretBackend,
): MigrationResult {
	const result: MigrationResult = {
		names:    { apiKey: "", claudeApiKey: "", localApiKey: "" },
		migrated: [],
		failed:   [],
	};

	for (const field of KEY_FIELDS) {
		const value    = typeof keys[field] === "string" ? keys[field].trim() : "";
		const existing = isValidSecretId(names[field]) ? names[field] : "";
		result.names[field] = existing;

		if (!value) continue;
		if (existing && readSecret(backend, existing) === value) continue;

		const id = existing || pickSecretId(backend, field, value);
		if (id && storeVerified(backend, id, value)) {
			result.names[field] = id;
			result.migrated.push(field);
		} else {
			result.failed.push(field);
		}
	}

	return result;
}

/** Reads the key behind each secret name. A missing secret is an empty key. */
export function resolveKeys(names: Partial<SecretNames>, backend: SecretBackend): KeyValues {
	const keys: KeyValues = { apiKey: "", claudeApiKey: "", localApiKey: "" };
	for (const field of KEY_FIELDS) {
		const name = names[field];
		if (isValidSecretId(name)) keys[field] = readSecret(backend, name)?.trim() ?? "";
	}
	return keys;
}
