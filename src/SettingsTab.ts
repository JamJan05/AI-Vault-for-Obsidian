import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t, setLanguage } from "./i18n";
import { DEFAULT_SYSTEM_PROMPTS } from "./settings";
import { FILE_API_KEYS } from "./constants";
import type { ExternalStorage } from "./storage/ExternalStorage";
import type { HistoryManager }  from "./history/HistoryManager";
import type { ProjectManager }  from "./history/ProjectManager";
import type { RAGEngine }       from "./rag/RAGEngine";
import type { GPTHistoryView }  from "./views/HistoryView";
import type { GPTProjectsView } from "./views/ProjectsView";
import type { PluginSettings }  from "./settings";

// ─── Plugin interface ──────────────────────────────────────────────────────────

interface PluginWithDeps {
	app:             App;
	settings:        PluginSettings;
	externalStorage: ExternalStorage;
	history:         HistoryManager;
	projects:        ProjectManager;
	rag:             RAGEngine;
	saveSettings():  Promise<void>;
	loadData():      Promise<Record<string, unknown>>;
	saveData(data: Record<string, unknown>): Promise<void>;
	getHistoryView():  GPTHistoryView | null;
	getProjectsView(): GPTProjectsView | null;
}

// ─── SettingsTab ───────────────────────────────────────────────────────────────

export class GPTSettingsTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PluginWithDeps) {
		super(app, plugin as never);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: t("settings_title") });

		this.renderLanguage(containerEl);
		this.renderKeyWarning(containerEl);
		this.renderApiKeySync(containerEl);
		this.renderOpenAIKeys(containerEl);
		this.renderClaude(containerEl);
		this.renderOpenAISettings(containerEl);
		this.renderContext(containerEl);
		this.renderRAG(containerEl);
		this.renderStorage(containerEl);
	}

	// ── Sections ───────────────────────────────────────────────────────────────

	private renderLanguage(el: HTMLElement): void {
		// Always in English — understandable regardless of the current language
		new Setting(el)
			.setName("Language / Język")
			.setDesc("Plugin interface language / Język interfejsu wtyczki")
			.addDropdown(d => d
				.addOption("en", "🇬🇧 English")
				.addOption("pl", "🇵🇱 Polski")
				.setValue(this.plugin.settings.language ?? "en")
				.onChange(async (v: string) => {
					this.plugin.settings.language = v as "en" | "pl";
					await this.plugin.saveSettings();
					setLanguage(v, this.plugin);
					this.display();
				}),
			);
	}

	private renderKeyWarning(el: HTMLElement): void {
		const warning = el.createEl("div", { cls: "gpt-settings-warning" });
		warning.innerHTML = t("settings_keys_local_warning_html");
	}

	private renderApiKeySync(el: HTMLElement): void {
		const keysInSync = this.plugin.settings.apiKeysInSync;
		const extEnabled = this.plugin.externalStorage.isEnabled;

		new Setting(el)
			.setName(t("settings_keys_sync_name"))
			.setDesc(keysInSync ? t("settings_keys_sync_desc_on") : t("settings_keys_sync_desc_off"))
			.addToggle(tog => tog
				.setValue(keysInSync)
				.setDisabled(!extEnabled)
				.onChange(async (v: boolean) => {
					const oldApiKey       = this.plugin.settings.apiKey;
					const oldClaudeApiKey = this.plugin.settings.claudeApiKey;
					this.plugin.settings.apiKeysInSync = v;
					this.plugin.settings.apiKey        = oldApiKey;
					this.plugin.settings.claudeApiKey  = oldClaudeApiKey;
					await this.plugin.saveSettings();

					if (v) {
						// Switched to Sync → remove keys.json
						const keysPath = this.plugin.externalStorage.resolve(FILE_API_KEYS);
						await this.plugin.externalStorage.remove(keysPath);
						new Notice(t("notice_keys_moved_sync"), 5000);
					} else {
						// Switched to local → keys saved via saveSettings, remove from data.json
						const d = await this.plugin.loadData();
						if (d) {
							delete d.apiKey;
							delete d.claudeApiKey;
							await this.plugin.saveData(d);
						}
						new Notice(t("notice_keys_moved_local"), 5000);
					}
					this.display();
				}),
			);

		if (!extEnabled) {
			el.createEl("div", {
				cls:  "gpt-settings-note",
				text: t("settings_keys_mobile_note"),
			});
		}
	}

	private renderOpenAIKeys(el: HTMLElement): void {
		const keysInSync      = this.plugin.settings.apiKeysInSync;
		const extEnabled      = this.plugin.externalStorage.isEnabled;
		const keysStoredLocal = !keysInSync && extEnabled;
		const keysLocation    = keysStoredLocal ? t("settings_key_local") : t("settings_key_sync");

		el.createEl("h3", { text: t("settings_openai_title") });

		new Setting(el)
			.setName(t("settings_openai_key_name"))
			.setDesc(keysLocation)
			.addText(txt => {
				txt.inputEl.type = "password";
				txt.setPlaceholder("sk-…")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v: string) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(el)
			.setName(t("settings_openai_model_name"))
			.addDropdown(d => d
				.addOption("gpt-5",            "GPT-5 (reasoning, best)")
				.addOption("gpt-5-mini",       "GPT-5 Mini (reasoning, faster)")
				.addOption("gpt-5-nano",       t("model_gpt5nano_label"))
				.addOption("gpt-5-search-api", "GPT-5 Search (web search 🌐)")
				.addOption("gpt-4o",           "GPT-4o (web search ✓)")
				.addOption("gpt-4o-mini",      "GPT-4o Mini (web search ✓)")
				.addOption("gpt-4-turbo",      "GPT-4 Turbo")
				.setValue(this.plugin.settings.model)
				.onChange(async (v: string) => {
					this.plugin.settings.model = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderOpenAISettings(el: HTMLElement): void {
		el.createEl("h3", { text: "⚙️ " + t("settings_openai_title") + " — " + t("settings_thinking_name") });

		new Setting(el)
			.setName(t("settings_thinking_name"))
			.addDropdown(d => d
				.addOption("fast",   t("chat_mode_fast"))
				.addOption("normal", t("chat_mode_normal"))
				.addOption("think",  t("chat_mode_think"))
				.setValue(this.plugin.settings.thinkingMode)
				.onChange(async (v: string) => {
					this.plugin.settings.thinkingMode = v as "fast" | "normal" | "think";
					await this.plugin.saveSettings();
				}),
			);

		el.createEl("h4", { text: t("settings_max_tokens_title") });

		new Setting(el)
			.setName(t("settings_max_tokens_fast_name"))
			.setDesc(t("settings_max_tokens_fast_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "256";
				txt.inputEl.style.width = "90px";
				txt.setValue(String(this.plugin.settings.maxTokensFast ?? 4096))
					.onChange(async (v: string) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= 256) {
							this.plugin.settings.maxTokensFast = n;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(el)
			.setName(t("settings_max_tokens_normal_name"))
			.setDesc(t("settings_max_tokens_normal_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "256";
				txt.inputEl.style.width = "90px";
				txt.setValue(String(this.plugin.settings.maxTokensNormal ?? 8192))
					.onChange(async (v: string) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= 256) {
							this.plugin.settings.maxTokensNormal = n;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(el)
			.setName(t("settings_max_tokens_think_name"))
			.setDesc(t("settings_max_tokens_think_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "256";
				txt.inputEl.style.width = "90px";
				txt.setValue(String(this.plugin.settings.maxTokensThink ?? 16000))
					.onChange(async (v: string) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= 256) {
							this.plugin.settings.maxTokensThink = n;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(el)
			.setName(t("settings_system_prompt_name"))
			.setDesc(t("settings_system_prompt_desc"))
			.addTextArea(ta => {
				ta.inputEl.rows = 4;
				ta.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (v: string) => {
						this.plugin.settings.systemPrompt = v;
						await this.plugin.saveSettings();
					});
			})
			.addButton(b => b
				.setButtonText(t("settings_system_prompt_reset"))
				.setTooltip(t("settings_system_prompt_reset_tip"))
				.onClick(async () => {
					const lang = this.plugin.settings.language ?? "en";
					this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPTS[lang] ?? DEFAULT_SYSTEM_PROMPTS.en;
					await this.plugin.saveSettings();
					this.display();
				}),
			);
	}

	private renderContext(el: HTMLElement): void {
		el.createEl("h3", { text: "💬 " + t("settings_context_title") });

		new Setting(el)
			.setName(t("settings_context_name"))
			.setDesc(t("settings_context_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "0";
				txt.inputEl.style.width = "90px";
				txt.setValue(String(this.plugin.settings.maxContextMessages ?? 0))
					.onChange(async (v: string) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.maxContextMessages = n;
							await this.plugin.saveSettings();
						}
					});
			});
	}

	private renderClaude(el: HTMLElement): void {
		const keysInSync      = this.plugin.settings.apiKeysInSync;
		const extEnabled      = this.plugin.externalStorage.isEnabled;
		const keysStoredLocal = !keysInSync && extEnabled;
		const keysLocation    = keysStoredLocal ? t("settings_key_local") : t("settings_key_sync");

		el.createEl("h3", { text: t("settings_claude_title") });

		new Setting(el)
			.setName(t("settings_claude_key_name"))
			.setDesc(keysLocation)
			.addText(txt => {
				txt.inputEl.type = "password";
				txt.setPlaceholder("sk-ant-…")
					.setValue(this.plugin.settings.claudeApiKey ?? "")
					.onChange(async (v: string) => {
						this.plugin.settings.claudeApiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(el)
			.setName(t("settings_claude_model_name"))
			.addDropdown(d => d
				.addOption("claude-opus-4-5",   "Claude Opus 4.5 (best)")
				.addOption("claude-sonnet-4-5", "Claude Sonnet 4.5 (recommended)")
				.addOption("claude-haiku-4-5",  "Claude Haiku 4.5 (fast / affordable)")
				.setValue(this.plugin.settings.claudeModel ?? "claude-sonnet-4-5")
				.onChange(async (v: string) => {
					this.plugin.settings.claudeModel = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderRAG(el: HTMLElement): void {
		el.createEl("h3", { text: t("settings_rag_title") });

		new Setting(el)
			.setName(t("settings_rag_enable_name"))
			.setDesc(t("settings_rag_enable_desc"))
			.addToggle(tog => tog
				.setValue(this.plugin.settings.ragEnabled)
				.onChange(async (v: boolean) => {
					this.plugin.settings.ragEnabled = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(el)
			.setName(t("settings_rag_auto_name"))
			.setDesc(t("settings_rag_auto_desc"))
			.addToggle(tog => tog
				.setValue(this.plugin.settings.ragAutoIndex)
				.onChange(async (v: boolean) => {
					this.plugin.settings.ragAutoIndex = v;
					await this.plugin.saveSettings();
				}),
			);

		// Status RAG
		const s   = this.plugin.rag.stats;
		const info = el.createEl("div", { cls: "gpt-settings-rag-status" });
		info.innerHTML = t("rag_status",
			this.plugin.rag.indexed ? t("rag_indexed") : t("rag_not_indexed"),
			s.files, s.chunks, s.embeddings,
		);

		new Setting(el)
			.setName(t("settings_rag_reindex_name"))
			.addButton(b => b
				.setButtonText(t("settings_rag_reindex_btn"))
				.setCta()
				.onClick(async () => {
					b.setButtonText(t("settings_rag_indexing")).setDisabled(true);
					await this.plugin.rag.buildIndex();
					const st = this.plugin.rag.stats;
					new Notice(t("rag_done", st.files));
					b.setButtonText(t("settings_rag_reindex_btn")).setDisabled(false);
					this.display();
				}),
			);
	}

	private renderStorage(el: HTMLElement): void {
		el.createEl("h3", { text: t("settings_storage_title") });

		const isDesktop   = this.plugin.externalStorage.isDesktop;
		const isActive    = this.plugin.externalStorage.isEnabled;
		const currentPath = this.plugin.externalStorage.baseDir
			?? this.plugin.externalStorage.getDefaultPath();

		// Status bar
		const info = el.createEl("div", { cls: "gpt-settings-storage-info" });
		if (!isDesktop) {
			info.innerHTML = t("settings_storage_mobile_full");
		} else if (isActive) {
			info.innerHTML =
				`✅ <strong>${t("settings_storage_active")}</strong><br>` +
				`Obsidian Sync does not sync this data.<br><br>` +
				`<strong>Location:</strong><br>` +
				`<code style="font-size:11px;word-break:break-all">${currentPath}</code>`;
		} else {
			info.innerHTML = t("settings_storage_inactive_html");
		}

		new Setting(el)
			.setName(t("settings_storage_name"))
			.setDesc(t("settings_storage_desc"))
			.addToggle(tog => tog
				.setValue(this.plugin.settings.externalStorageEnabled)
				.setDisabled(!isDesktop)
				.onChange(async (v: boolean) => {
					this.plugin.settings.externalStorageEnabled = v;
					await this.plugin.saveSettings();
					new Notice(t("notice_restart_required"), 6000);
					this.display();
				}),
			);

		const defaultPath = this.plugin.externalStorage.getDefaultPath()
			|| t("settings_storage_mobile_na");

		new Setting(el)
			.setName(t("settings_storage_path_name"))
			.setDesc(t("settings_storage_path_desc", defaultPath))
			.addText(txt => {
				txt.setPlaceholder("/path/to/folder (empty = auto)")
					.setValue(this.plugin.settings.externalStoragePath ?? "")
					.setDisabled(!isDesktop);
				txt.inputEl.style.width = "100%";
				txt.onChange(async (v: string) => {
					this.plugin.settings.externalStoragePath = v.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName(t("settings_storage_migrate_name"))
			.setDesc(t("settings_storage_migrate_desc"))
			.addButton(b => b
				.setButtonText(t("settings_storage_migrate_btn"))
				.setDisabled(!isActive)
				.onClick(async () => {
					b.setButtonText(t("settings_storage_migrating")).setDisabled(true);
					try {
						const r = await this.plugin.externalStorage.migrateFromVault();
						await this.plugin.history.load();
						await this.plugin.projects.load();
						this.plugin.getHistoryView()?.render();
						this.plugin.getProjectsView()?.render();

						if (r.errors.length === 0) {
							new Notice(t("notice_migrated_manual", r.moved, r.skipped), 5000);
						} else {
							new Notice(t("notice_migration_partial_short", r.moved, r.errors.length), 6000);
							console.error("[AI-Vault] Migration errors:", r.errors);
						}
					} catch (e) {
						new Notice(t("notice_migration_failed", (e as Error)?.message));
						console.error("[AI-Vault] Migration crashed:", e);
					} finally {
						b.setButtonText(t("settings_storage_migrate_btn")).setDisabled(!isActive);
						this.display();
					}
				}),
			);

		new Setting(el)
			.setName(t("settings_storage_open_name"))
			.setDesc(t("settings_storage_open_desc"))
			.addButton(b => b
				.setButtonText(t("settings_storage_open_btn"))
				.setDisabled(!isActive)
				.onClick(() => {
					try {
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const { shell } = require("electron") as { shell: { openPath: (p: string) => void } };
						shell.openPath(this.plugin.externalStorage.baseDir ?? "");
					} catch (e) {
						new Notice(t("notice_storage_open_fail", (e as Error)?.message));
					}
				}),
			);
	}
}
