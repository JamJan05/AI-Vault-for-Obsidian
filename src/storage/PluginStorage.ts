import type { Plugin } from "obsidian";
import { isPathInside } from "../security/paths";

export interface ListResult {
	files:   string[];
	folders: string[];
}

/**
 * Storage layer backed by the Obsidian vault adapter.
 * Works on desktop and mobile — always available as a fallback.
 *
 * The adapter is used rather than the Vault API because every path this class
 * touches lives in the plugin's own folder under the vault config directory.
 * Those files are not part of the vault file index, so `getFileByPath` cannot
 * reach them, and `saveData`/`loadData` only covers a single `data.json` while
 * the plugin needs a `history/` directory with one file per session.
 *
 * The adapter is read once here so the whole class has a single point where
 * vault-wide file access is obtained, and every path is confined to
 * {@link baseDir} before it reaches that adapter.
 */
export class PluginStorage {
	private readonly adapter: import("obsidian").DataAdapter;

	constructor(private readonly plugin: Plugin) {
		this.adapter = plugin.app.vault.adapter;
	}

	/** Plugin folder inside the vault config directory. */
	get baseDir(): string {
		return (
			this.plugin.manifest.dir ||
			`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`
		);
	}

	/** Joins baseDir with the given path parts */
	resolve(...parts: string[]): string {
		return [this.baseDir, ...parts].join("/");
	}

	/**
	 * Guards every adapter call. The adapter can reach any file in the vault,
	 * including user notes, so a path that was not built through {@link resolve}
	 * is refused instead of written. Returns false rather than throwing so a
	 * rejected path degrades to "operation refused", not "plugin crashes".
	 *
	 * The rejected path is deliberately not logged: it could be a note path,
	 * and note content never belongs in the console.
	 */
	private _insideBase(filePath: string): boolean {
		if (isPathInside(this.baseDir, filePath)) return true;
		console.warn("[AI-Vault] Refused a storage path outside the plugin directory");
		return false;
	}

	async ensureDir(dirPath: string): Promise<void> {
		if (!this._insideBase(dirPath)) return;
		try {
			if (!(await this.adapter.exists(dirPath))) {
				await this.adapter.mkdir(dirPath);
			}
		} catch (e) {
			console.warn("[AI-Vault] ensureDir failed:", dirPath, e);
		}
	}

	async exists(filePath: string): Promise<boolean> {
		if (!this._insideBase(filePath)) return false;
		try {
			return await this.adapter.exists(filePath);
		} catch {
			return false;
		}
	}

	async readJson<T>(filePath: string, fallback: T): Promise<T> {
		if (!this._insideBase(filePath)) return fallback;
		try {
			if (!(await this.adapter.exists(filePath))) return fallback;
			const raw = await this.adapter.read(filePath);
			return JSON.parse(raw) as T;
		} catch (e) {
			console.warn("[AI-Vault] readJson failed:", filePath, (e as Error)?.message);
			return fallback;
		}
	}

	async writeJson(filePath: string, data: unknown): Promise<boolean> {
		if (!this._insideBase(filePath)) return false;
		try {
			const dir = filePath.split("/").slice(0, -1).join("/");
			if (dir) await this.ensureDir(dir);

			const payload = JSON.stringify(data);
			const tmp = `${filePath}.tmp`;

			// Atomic write: temp → rename, so an interrupted write cannot leave
			// truncated history behind. `rename` is not documented to replace an
			// existing file on every platform Obsidian runs on, so a failure falls
			// back to a direct write instead of dropping the update.
			try {
				await this.adapter.write(tmp, payload);
				await this.adapter.rename(tmp, filePath);
				return true;
			} catch (e) {
				console.warn(
					"[AI-Vault] atomic write unavailable, writing in place:",
					filePath,
					(e as Error)?.message,
				);
				await this.adapter.write(filePath, payload);
				await this.remove(tmp);
				return true;
			}
		} catch (e) {
			console.error("[AI-Vault] writeJson failed:", filePath, e);
			return false;
		}
	}

	async remove(filePath: string): Promise<void> {
		if (!this._insideBase(filePath)) return;
		try {
			if (await this.adapter.exists(filePath)) await this.adapter.remove(filePath);
		} catch (e) {
			console.warn("[AI-Vault] remove failed:", filePath, e);
		}
	}

	/** Removes a directory. Non-recursive by default: an unexpected leftover file is kept. */
	async removeDir(dirPath: string, recursive = false): Promise<void> {
		if (!this._insideBase(dirPath)) return;
		try {
			await this.adapter.rmdir(dirPath, recursive);
		} catch (e) {
			console.warn("[AI-Vault] removeDir failed:", dirPath, (e as Error)?.message);
		}
	}

	async list(dirPath: string): Promise<ListResult> {
		if (!this._insideBase(dirPath)) return { files: [], folders: [] };
		try {
			if (!(await this.adapter.exists(dirPath))) return { files: [], folders: [] };
			return await this.adapter.list(dirPath);
		} catch {
			return { files: [], folders: [] };
		}
	}
}
