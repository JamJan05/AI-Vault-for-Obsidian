import type { App } from "obsidian";
import type { NoteVault } from "./noteTools";

/**
 * The vault as the note tools see it. Changes go through Obsidian's Vault API,
 * so open editors, sync and file recovery see them like any other edit.
 */
export function createNoteVault(app: App): NoteVault {
	const { vault } = app;

	return {
		configDir: vault.configDir,

		// Only reached from a tool call, which needs the user's switch in the chat view.
		listNotes: () => vault.getFiles()
			.filter(file => file.extension === "md" || file.extension === "canvas")
			.map(file => file.path),

		async read(path: string): Promise<string | null> {
			const file = vault.getFileByPath(path);
			return file ? vault.read(file) : null;
		},

		exists: (path: string) => vault.getAbstractFileByPath(path) !== null,

		async replace(path: string, expected: string, next: string, guard: () => void): Promise<void> {
			const file = vault.getFileByPath(path);
			if (!file) throw new Error("The note no longer exists.");
			await vault.process(file, current => {
				// The user approved a change to the text they were shown, and nothing else.
				if (current !== expected) throw new Error("The note changed in the meantime. Read it again.");
				guard();
				return next;
			});
		},

		async create(path: string, content: string, guard: () => void): Promise<void> {
			const folders = path.split("/").slice(0, -1);
			let prefix = "";
			for (const folder of folders) {
				prefix = prefix ? `${prefix}/${folder}` : folder;
				guard();
				if (!vault.getAbstractFileByPath(prefix)) await vault.createFolder(prefix);
			}
			guard();
			await vault.create(path, content);
		},
	};
}
