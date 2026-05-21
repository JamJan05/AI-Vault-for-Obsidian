import type { Plugin } from "obsidian";

export interface ListResult {
	files:   string[];
	folders: string[];
}

/**
 * Storage layer backed by the Obsidian vault adapter.
 * Works on desktop and mobile — always available as a fallback.
 */
export class PluginStorage {
	private readonly adapter: import("obsidian").DataAdapter;

	constructor(private readonly plugin: Plugin) {
		this.adapter = plugin.app.vault.adapter;
	}

	/** Plugin folder inside the vault config (.obsidian/plugins/<id>) */
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

	async ensureDir(dirPath: string): Promise<void> {
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(dirPath))) {
				await a.mkdir(dirPath);
			}
		} catch (e) {
			console.warn("[AI-Vault] ensureDir failed:", dirPath, e);
		}
	}

	async exists(filePath: string): Promise<boolean> {
		try {
			return await this.plugin.app.vault.adapter.exists(filePath);
		} catch {
			return false;
		}
	}

	async readJson<T>(filePath: string, fallback: T): Promise<T> {
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(filePath))) return fallback;
			const raw = await a.read(filePath);
			return JSON.parse(raw) as T;
		} catch (e) {
			console.warn("[AI-Vault] readJson failed:", filePath, (e as Error)?.message);
			return fallback;
		}
	}

	async writeJson(filePath: string, data: unknown): Promise<boolean> {
		try {
			const dir = filePath.split("/").slice(0, -1).join("/");
			if (dir) await this.ensureDir(dir);
			await this.plugin.app.vault.adapter.write(filePath, JSON.stringify(data));
			return true;
		} catch (e) {
			console.error("[AI-Vault] writeJson failed:", filePath, e);
			return false;
		}
	}

	async remove(filePath: string): Promise<void> {
		try {
			const a = this.plugin.app.vault.adapter;
			if (await a.exists(filePath)) await a.remove(filePath);
		} catch (e) {
			console.warn("[AI-Vault] remove failed:", filePath, e);
		}
	}

	async list(dirPath: string): Promise<ListResult> {
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(dirPath))) return { files: [], folders: [] };
			return await a.list(dirPath) as ListResult;
		} catch {
			return { files: [], folders: [] };
		}
	}
}
