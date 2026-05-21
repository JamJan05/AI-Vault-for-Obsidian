import type { Plugin } from "obsidian";
import { t } from "../i18n";
import {
	DIR_HISTORY,
	FILE_HISTORY_INDEX,
	FILE_PROJECTS,
	FILE_RAG_INDEX,
} from "../constants";
import type { PluginStorage, ListResult } from "./PluginStorage";

// Node.js types — available only on desktop
type FSPromises = typeof import("fs/promises");
type NodePath   = typeof import("path");

interface MigrateResult {
	moved:   number;
	skipped: number;
	errors:  string[];
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
	private _fs:      FSPromises | null = null;
	private _path:    NodePath   | null = null;
	private _desktop  = false;
	private _baseDir: string | null = null;
	private _enabled  = false;

	constructor(
		private readonly plugin:   Plugin,
		private readonly fallback: PluginStorage,
	) {
		// Detect desktop — Obsidian on desktop exposes Node via require()
		try {
			if (
				typeof process !== "undefined" &&
				process.versions &&
				process.versions.node
			) {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				this._fs      = require("fs/promises") as FSPromises;
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				this._path    = require("path") as NodePath;
				this._desktop = true;
			}
		} catch (e) {
			console.warn(
				"[AI-Vault] Node fs unavailable — external storage disabled (mobile?)",
				(e as Error)?.message,
			);
		}
	}

	// ── Getters ────────────────────────────────────────────────────────────────

	get isDesktop(): boolean { return this._desktop; }
	get isEnabled(): boolean { return this._enabled && this._desktop; }
	get baseDir():   string | null { return this._baseDir; }

	// ── Initialization ─────────────────────────────────────────────────────────

	/**
	 * Initializes the storage.
	 * @returns true if external storage is active, false = we use the fallback
	 */
	async init(): Promise<boolean> {
		if (!this._desktop) {
			this._enabled = false;
			return false;
		}

		// Cast to any to read settings because the plugin is generic here
		const settings = (this.plugin as unknown as { settings: { externalStorageEnabled: boolean } }).settings;
		if (!settings.externalStorageEnabled) {
			this._enabled = false;
			return false;
		}

		try {
			this._baseDir = this._resolveBaseDir();
			await this._fs!.mkdir(this._baseDir, { recursive: true });
			this._enabled = true;
			return true;
		} catch (e) {
			console.error("[AI-Vault] Failed to init external storage:", e);
			this._enabled = false;
			return false;
		}
	}

	// ── Paths ──────────────────────────────────────────────────────────────────

	/**
	 * Computes the default path: {parent_of_vault}/{vaultName}-gpt-data
	 * Or uses settings.externalStoragePath if set.
	 */
	private _resolveBaseDir(): string {
		const settings = (this.plugin as unknown as {
			settings: { externalStoragePath: string };
		}).settings;

		const custom = (settings.externalStoragePath || "").trim();
		if (custom) return this._path!.resolve(custom);

		// vault.adapter.basePath exists on desktop
		const adapter   = this.plugin.app.vault.adapter as unknown as {
			basePath?: string;
			getBasePath?: () => string;
		};
		const vaultPath = adapter.basePath ?? adapter.getBasePath?.();
		if (!vaultPath) throw new Error("Cannot determine vault path");

		const parent    = this._path!.dirname(vaultPath);
		const vaultName = this._path!.basename(vaultPath);
		return this._path!.join(parent, `${vaultName}-gpt-data`);
	}

	/** Returns the default path or an empty string when unavailable */
	getDefaultPath(): string {
		try { return this._resolveBaseDir(); }
		catch { return ""; }
	}

	/** Resolves a path relative to baseDir — falls back to PluginStorage when disabled */
	resolve(...parts: string[]): string {
		if (this.isEnabled) return this._path!.join(this._baseDir!, ...parts);
		return this.fallback.resolve(...parts);
	}

	// ── CRUD ───────────────────────────────────────────────────────────────────

	async ensureDir(dirPath: string): Promise<void> {
		if (this.isEnabled) {
			try { await this._fs!.mkdir(dirPath, { recursive: true }); }
			catch (e) { console.warn("[AI-Vault] ensureDir failed:", dirPath, (e as Error)?.message); }
			return;
		}
		return this.fallback.ensureDir(dirPath);
	}

	async exists(filePath: string): Promise<boolean> {
		if (this.isEnabled) {
			try { await this._fs!.access(filePath); return true; }
			catch { return false; }
		}
		return this.fallback.exists(filePath);
	}

	async readJson<T>(filePath: string, fallback: T): Promise<T> {
		if (this.isEnabled) {
			try {
				const raw = await this._fs!.readFile(filePath, "utf-8");
				return JSON.parse(raw) as T;
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") {
					console.warn("[AI-Vault] readJson failed:", filePath, err?.message);
				}
				return fallback;
			}
		}
		return this.fallback.readJson(filePath, fallback);
	}

	async writeJson(filePath: string, data: unknown): Promise<boolean> {
		if (this.isEnabled) {
			try {
				const dir = this._path!.dirname(filePath);
				await this._fs!.mkdir(dir, { recursive: true });

				// Atomic write: temp → rename (guards against corrupted JSON)
				const tmp = `${filePath}.tmp`;
				await this._fs!.writeFile(tmp, JSON.stringify(data), "utf-8");
				await this._fs!.rename(tmp, filePath);
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
			try { await this._fs!.unlink(filePath); }
			catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code !== "ENOENT") {
					console.warn("[AI-Vault] remove failed:", filePath, err?.message);
				}
			}
			return;
		}
		return this.fallback.remove(filePath);
	}

	async list(dirPath: string): Promise<ListResult> {
		if (this.isEnabled) {
			try {
				const entries = await this._fs!.readdir(dirPath, { withFileTypes: true });
				const files: string[]   = [];
				const folders: string[] = [];

				for (const ent of entries) {
					const full = this._path!.join(dirPath, ent.name);
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
				result.errors.push(`${fname}: ${(e as Error)?.message ?? e}`);
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
						const dstFile  = this._path!.join(dstDir, fileName);

						const data = await vault.readJson<unknown>(srcFile, null);
						if (data === null) continue;

						const ok = await this.writeJson(dstFile, data);
						if (ok) {
							await vault.remove(srcFile);
							result.moved++;
						}
					} catch (e) {
						result.errors.push(`history/${srcFile}: ${(e as Error)?.message}`);
					}
				}

				// Try to remove the now-empty history/ folder from the vault
				try {
					const adapter = this.plugin.app.vault.adapter as unknown as {
						rmdir?: (path: string, recursive: boolean) => Promise<void>;
					};
					await adapter.rmdir?.(srcDir, false);
				} catch {
					// Harmless if the folder is not empty or the operation is unsupported
				}
			}
		} catch (e) {
			result.errors.push(`history dir: ${(e as Error)?.message}`);
		}

		return result;
	}
}
