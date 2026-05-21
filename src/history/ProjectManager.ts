import { FILE_PROJECTS } from "../constants";
import { t } from "../i18n";
import type { ExternalStorage } from "../storage/ExternalStorage";
import type { HistoryManager } from "./HistoryManager";
import type { Project, SessionMeta, ChatMessage } from "../types";

interface PluginWithDeps {
	externalStorage: ExternalStorage;
	history:         HistoryManager;
}

const PROJECT_COLORS = [
	"#10a37f", "#7c3aed", "#2563eb",
	"#e74c3c", "#f59e0b", "#ec4899",
	"#06b6d4", "#84cc16",
] as const;

/**
 * Manages projects — groups of chats that share context and a system prompt.
 */
export class ProjectManager {
	projects: Project[] = [];

	private readonly storage: ExternalStorage;

	constructor(private readonly plugin: PluginWithDeps) {
		this.storage = plugin.externalStorage;
	}

	// ── Paths ──────────────────────────────────────────────────────────────────

	get filePath(): string { return this.storage.resolve(FILE_PROJECTS); }

	// ── Load / save ────────────────────────────────────────────────────────────

	async load(): Promise<void> {
		const data = await this.storage.readJson<Project[]>(this.filePath, []);
		this.projects = Array.isArray(data) ? data : [];
	}

	async save(): Promise<void> {
		await this.storage.writeJson(this.filePath, this.projects);
	}

	// ── Project CRUD ───────────────────────────────────────────────────────────

	async createProject(
		name:         string,
		description   = "",
		customPrompt  = "",
	): Promise<Project> {
		const project: Project = {
			id:           Date.now().toString(),
			name,
			color:        this.randomColor(),
			systemPrompt: customPrompt,
			createdAt:    Date.now(),
			updatedAt:    Date.now(),
		};

		this.projects.unshift(project);
		await this.save();
		return project;
	}

	async updateProject(id: string, data: Partial<Project>): Promise<void> {
		const project = this.projects.find(p => p.id === id);
		if (!project) return;

		Object.assign(project, data, { updatedAt: Date.now() });
		await this.save();
	}

	async deleteProject(id: string): Promise<void> {
		this.projects = this.projects.filter(p => p.id !== id);

		// Detach sessions from the deleted project
		for (const session of this.plugin.history.sessions) {
			if (session.projectId === id) session.projectId = null;
		}

		await this.plugin.history.save();
		await this.save();
	}

	getProject(id: string): Project | null {
		return this.projects.find(p => p.id === id) ?? null;
	}

	// ── Project sessions ───────────────────────────────────────────────────────

	getProjectSessions(projectId: string): SessionMeta[] {
		return this.plugin.history.sessions
			.filter(s => s.projectId === projectId)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	// ── Project context (for the system prompt) ────────────────────────────────

	/**
	 * Builds context from previous chats in the project.
	 * Injected as extra context for every query within the project.
	 */
	async buildProjectContext(
		projectId:        string,
		currentSessionId: string,
		maxChars          = 4000,
	): Promise<string> {
		const sessions = this.getProjectSessions(projectId)
			.filter(s => s.id !== currentSessionId);

		if (!sessions.length) return "";

		let ctx = "";
		for (const session of sessions) {
			const summary = await this.summarizeSession(session);
			if (!summary) continue;
			if (ctx.length + summary.length > maxChars) break;
			ctx += summary + "\n\n---\n\n";
		}
		return ctx;
	}

	/** Builds a short session summary (last 6 messages) */
	async summarizeSession(session: SessionMeta & { messages?: ChatMessage[] }): Promise<string> {
		const messages: ChatMessage[] =
			session.messages ?? await this.plugin.history.getMessages(session.id);

		if (!messages.length) return "";

		const title  = session.title || "Rozmowa";
		const recent = messages.slice(-6);

		const lines = recent.map(m => {
			const role = m.role === "user"
				? t("export_role_user")
				: t("export_role_assistant");
			const text = m.content.length > 300
				? m.content.slice(0, 300) + "…"
				: m.content;
			return `${role}: ${text}`;
		});

		return `### Chat: ${title}\n${lines.join("\n")}`;
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	private randomColor(): string {
		return PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
	}
}
