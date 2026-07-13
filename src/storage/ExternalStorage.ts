import { FileSystemAdapter, Platform } from "obsidian";
import * as nodeFsModule from "fs/promises";
import * as nodePathModule from "path";
import { t } from "../i18n";
import {
	DIR_HISTORY,
	FILE_HISTORY_INDEX,
	FILE_PROJECTS,
	FILE_RAG_INDEX,
} from "../constants";
import type { PluginStorage, ListResult } from "./PluginStorage";
import type { PluginSettings } from "../settings";
import type { Plugin } from "obsidian";

interface NodeDirent {
	name: string;
	isDirectory(): boolean;
}

interface NodeFsPromises {
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	access(path: string): Promise<void>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	readdir(path: string, options: { withFileTypes: true }): Promise<NodeDirent[]>;
}

interface NodePathApi {
	resolve(path: string): string;
	dirname(path: string): string;
	basename(path: string): string;
	join(...paths: string[]): string;
}

interface MigrateResult {
	moved:   number;
	skipped: number;
	errors:  string[];
}

interface ExternalStoragePlugin extends Plugin {
	settings: Pick<PluginSettings, "externalStorageEnabled" | "externalStoragePath">;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasFunctions(value: unknown, names: string[]): value is Record<string, (...args: unknown[]) => unknown> {
	return isRecord(value) && names.every(name => typeof value[name] === "function");
}

function isNodeFsPromises(value: unknown): value is NodeFsPromises {
	return hasFunctions(value, ["mkdir", "access", "readFile", "writeFile", "rename", "unlink", "readdir"]);
}

function isNodePathApi(value: unknown): value is NodePathApi {
	return hasFunctions(value, ["resolve", "dirname", "basename", "join"]);
}

/**
 * Node built-ins do not have one consistent runtime shape across the Electron
 * versions used by Obsidian. Native ESM exposes the methods directly, while
 * CommonJS interop can put the whole module under `default`.
 */
function getModuleApi<T>(
	value: unknown,
	isApi: (candidate: unknown) => candidate is T,
): T | null {
	if (isApi(value)) return value;
	if (isRecord(value) && isApi(value.default)) return value.default;
	return null;
}

/**
 * Storage that writes data to a local system directory NEXT TO the vault folder.
 * Obsidian Sync does NOT synchronize these files.
 *
 * Works only on DESKTOP (requires Node.js fs/path).
 * On mobile it automatically delegates to PluginStorage (vault adapter).
 *
 * Default path: {parent_of_vault}/{vault_name}-gpt-data
 * Can be overridden via settings.externalStoragePath.
 */
export class ExternalStorage {
	private _fs:      NodeFsPromises | null = null;
	private _path:    NodePathApi     | null = null;
	private _desktop  = false;
	private _baseDir: string | null = null;
	private _enabled  = false;
	private _lastError: string | null = null;

	constructor(
		private readonly plugin:   ExternalStoragePlugin,
		private readonly fallback: PluginStorage,
	) {}

	private async _loadNodeModules(): Promise<boolean> {
		if (!Platform.isDesktopApp) return false;
		if (this._fs && this._path) {
			this._desktop = true;
			return true;
		}

		try {
			// Static imports are bundled as CommonJS require calls, which is the module
			// system used by Obsidian plugins. Native dynamic imports are unreliable in
			// some Electron versions and previously left the settings toggles disabled.
			const fsApi = getModuleApi(nodeFsModule, isNodeFsPromises);
			const pathApi = getModuleApi(nodePathModule, isNodePathApi);
			if (!fsApi || !pathApi) {
				throw new Error("Unexpected Node module shape");
			}
			this._fs = fsApi;
			this._path = pathApi;
			this._desktop = true;
			this._lastError = null;
			return true;
		} catch (e) {
			this._lastError = errorMessage(e);
			console.warn(
				"[AI-Vault] Node fs unavailable; external storage disabled",
				this._lastError,
			);
			return false;
		}
	}

	private get nodeFs(): NodeFsPromises {
		if (!this._fs) throw new Error("Node fs is unavailable");
		return this._fs;
	}

	private get nodePath(): NodePathApi {
		if (!this._path) throw new Error("Node path is unavailable");
		return this._path;
	}

	// ── Getters ────────────────────────────────────────────────────────────────

	get isDesktop(): boolean { return Platform.isDesktopApp; }
	get isEnabled(): boolean { return this._enabled && this._desktop; }
	get baseDir():   string | null { return this._baseDir; }
	get lastError(): string | null { return this._lastError; }

	// ── Initialization ─────────────────────────────────────────────────────────

	/**
	 * Initializes the storage.
	 * @returns true if external storage is active, false = we use the fallback
	 */
	async init(): Promise<boolean> {
		if (!(await this._loadNodeModules())) {
			this._enabled = false;
			return false;
		}

		if (!this.plugin.settings.externalStorageEnabled) {
			this._enabled = false;
			return false;
		}

		try {
			this._baseDir = this._resolveBaseDir();
			await this.nodeFs.mkdir(this._baseDir, { recursive: true });
			this._enabled = true;
			this._lastError = null;
			return true;
		} catch (e) {
			this._lastError = errorMessage(e);
			console.error("[AI-Vault] Failed to init external storage:", e);
			this._enabled = false;
			return false;
		}
	}

	disable(): void {
		this._enabled = false;
		this._baseDir = null;
	}

	// ── Paths ──────────────────────────────────────────────────────────────────

	/**
	 * Computes the default path: {parent_of_vault}/{vaultName}-gpt-data
	 * Or uses settings.externalStoragePath if set.
	 */
	private _resolveBaseDir(): string {
		const custom = this.plugin.settings.externalStoragePath.trim();
		if (custom) return this.nodePath.resolve(custom);

		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Cannot determine vault path");
		const vaultPath = adapter.getBasePath();

		const parent    = this.nodePath.dirname(vaultPath);
		const vaultName = this.nodePath.basename(vaultPath);
		return this.nodePath.join(parent, `${vaultName}-gpt-data`);
	}

	/** Returns the default path or an empty string when unavailable */
	getDefaultPath(): string {
		try { return this._resolveBaseDir(); }
		catch { return ""; }
	}

	/** Resolves a path relative to baseDir — falls back to PluginStorage when disabled */
	resolve(...parts: string[]): string {
		if (this.isEnabled && this._baseDir) return this.nodePath.join(this._baseDir, ...parts);
		return this.fallback.resolve(...parts);
	}

	// ── CRUD ───────────────────────────────────────────────────────────────────

	async ensureDir(dirPath: string): Promise<void> {
		if (this.isEnabled) {
			try { await this.nodeFs.mkdir(dirPath, { recursive: true }); }
			catch (e) { console.warn("[AI-Vault] ensureDir failed:", dirPath, errorMessage(e)); }
			return;
		}
		return this.fallback.ensureDir(dirPath);
	}

	async exists(filePath: string): Promise<boolean> {
		if (this.isEnabled) {
			try { await this.nodeFs.access(filePath); return true; }
			catch { return false; }
		}
		return this.fallback.exists(filePath);
	}

	async readJson<T>(filePath: string, fallback: T): Promise<T> {
		if (this.isEnabled) {
			try {
				const raw = await this.nodeFs.readFile(filePath, "utf-8");
				const parsed: unknown = JSON.parse(raw);
				return parsed as T;
			} catch (e) {
				if (errorCode(e) !== "ENOENT") {
					console.warn("[AI-Vault] readJson failed:", filePath, errorMessage(e));
				}
				return fallback;
			}
		}
		return this.fallback.readJson(filePath, fallback);
	}

	async writeJson(filePath: string, data: unknown): Promise<boolean> {
		if (this.isEnabled) {
			try {
				const dir = this.nodePath.dirname(filePath);
				await this.nodeFs.mkdir(dir, { recursive: true });

				// Atomic write: temp → rename (guards against corrupted JSON)
				const tmp = `${filePath}.tmp`;
				await this.nodeFs.writeFile(tmp, JSON.stringify(data), "utf-8");
				await this.nodeFs.rename(tmp, filePath);
				return true;
			} catch (e) {
				console.error("[AI-Vault] writeJson failed:", filePath, e);
				return false;
			}
		}
		return this.fallback.writeJson(filePath, data);
	}

	async remove(filePath: string): Promise<void> {
		if (this.isEnabled) {
			try { await this.nodeFs.unlink(filePath); }
			catch (e) {
				if (errorCode(e) !== "ENOENT") {
					console.warn("[AI-Vault] remove failed:", filePath, errorMessage(e));
				}
			}
			return;
		}
		return this.fallback.remove(filePath);
	}

	async list(dirPath: string): Promise<ListResult> {
		if (this.isEnabled) {
			try {
				const entries = await this.nodeFs.readdir(dirPath, { withFileTypes: true });
				const files: string[]   = [];
				const folders: string[] = [];

				for (const ent of entries) {
					const full = this.nodePath.join(dirPath, ent.name);
					if (ent.isDirectory()) folders.push(full);
					else files.push(full);
				}

				return { files, folders };
			} catch {
				return { files: [], folders: [] };
			}
		}
		return this.fallback.list(dirPath);
	}

	// ── Migration ──────────────────────────────────────────────────────────────

	/**
	 * Migrates data from the vault (PluginStorage) → external folder.
	 * Moves: history-index.json, history/, projects.json, rag-index.json
	 * On success it removes the files from the vault.
	 */
	async migrateFromVault(): Promise<MigrateResult> {
		const result: MigrateResult = { moved: 0, skipped: 0, errors: [] };

		if (!this.isEnabled) {
			result.errors.push("External storage nieaktywny");
			return result;
		}

		const vault = this.fallback;
		const singleFiles = [FILE_HISTORY_INDEX, FILE_PROJECTS, FILE_RAG_INDEX];

		// Single JSON files
		for (const fname of singleFiles) {
			const src = vault.resolve(fname);
			const dst = this.resolve(fname);

			try {
				if (!(await vault.exists(src))) { result.skipped++; continue; }

				const data = await vault.readJson<unknown>(src, null);
				if (data === null) { result.skipped++; continue; }

				const ok = await this.writeJson(dst, data);
				if (ok) {
					await vault.remove(src);
					result.moved++;
				} else {
					result.errors.push(t("storage_save_error", fname));
				}
			} catch (e) {
				result.errors.push(`${fname}: ${errorMessage(e)}`);
			}
		}

		// history/ folder — all session-*.json files
		try {
			const srcDir = vault.resolve(DIR_HISTORY);
			const dstDir = this.resolve(DIR_HISTORY);

			if (await vault.exists(srcDir)) {
				await this.ensureDir(dstDir);
				const { files } = await vault.list(srcDir);

				for (const srcFile of files) {
					try {
						const fileName = srcFile.split("/").pop() ?? "";
						const dstFile  = this.nodePath.join(dstDir, fileName);

						const data = await vault.readJson<unknown>(srcFile, null);
						if (data === null) continue;

						const ok = await this.writeJson(dstFile, data);
						if (ok) {
							await vault.remove(srcFile);
							result.moved++;
						}
					} catch (e) {
						result.errors.push(`history/${srcFile}: ${errorMessage(e)}`);
					}
				}

				// Try to remove the now-empty history/ folder from the vault
				try {
					await this.plugin.app.vault.adapter.rmdir(srcDir, false);
				} catch {
					// Harmless if the folder is not empty or the operation is unsupported
				}
			}
		} catch (e) {
			result.errors.push(`history dir: ${errorMessage(e)}`);
		}

		return result;
	}
}
