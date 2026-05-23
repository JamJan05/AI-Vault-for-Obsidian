import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t, setLanguage } from "./i18n";
import { DEFAULT_SYSTEM_PROMPTS } from "./settings";
import { detectProvider } from "./models";
import { fetchOllamaModels } from "./api/ollama";
import { FILE_API_KEYS } from "./constants";
import type { ExternalStorage } from "./storage/ExternalStorage";
import type { HistoryManager }  from "./history/HistoryManager";
import type { ProjectManager }  from "./history/ProjectManager";
import type { RAGEngine }       from "./rag/RAGEngine";
import type { GPTHistoryView }  from "./views/HistoryView";
import type { GPTProjectsView } from "./views/ProjectsView";
import type { PluginSettings, Provider } from "./settings";

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
	private ollamaModels: string[] = [];

	constructor(app: App, private readonly plugin: PluginWithDeps) {
		super(app, plugin as never);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName(t("settings_title"))
			.setHeading();

		this.renderLanguage(containerEl);
		this.renderKeyWarning(containerEl);
		this.renderApiKeySync(containerEl);
		this.renderModelSelector(containerEl);
		this.renderOpenAISettings(containerEl);
		this.renderContext(containerEl);
		this.renderRAG(containerEl);
		this.renderStorage(containerEl);
	}

	private renderSafeInlineMarkup(el: HTMLElement, markup: string): void {
		el.empty();
		const stack: HTMLElement[] = [el];
		const tokens = markup.split(/(<\/?(?:strong|em|code|br)\b[^>]*>|&nbsp;)/gi);

		for (const token of tokens) {
			if (!token) continue;
			const parent = stack[stack.length - 1];
			const tagMatch = token.match(/^<\/?(strong|em|code|br)\b[^>]*>$/i);

			if (tagMatch) {
				const tag = tagMatch[1].toLowerCase();
				const isClosing = token.startsWith("</");
				if (tag === "br") {
					parent.createEl("br");
				} else if (isClosing) {
					if (stack.length > 1) stack.pop();
				} else if (tag === "strong") {
					stack.push(parent.createEl("strong"));
				} else if (tag === "em") {
					stack.push(parent.createEl("em"));
				} else {
					stack.push(parent.createEl("code"));
				}
				continue;
			}

			parent.appendChild(parent.ownerDocument.createTextNode(token === "&nbsp;" ? "\u00a0" : token));
		}
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
		this.renderSafeInlineMarkup(warning, t("settings_keys_local_warning_html"));
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

	private renderModelSelector(el: HTMLElement): void {
		const currentModel = this.getCurrentActiveModel();
		const ollamaModels = this.getOllamaModelOptions();
		const knownModels  = new Set<string>();

		new Setting(el)
			.setName("Model")
			.setHeading();

		new Setting(el)
			.setName("Active model")
			.setDesc("Provider is detected automatically from the model name.")
			.addDropdown(d => {
				const addModel = (id: string, label: string): void => {
					knownModels.add(id);
					d.addOption(id, label);
				};

				d.addOption("__openai_header__", "--- OpenAI ---");
				addModel("gpt-5",            "GPT-5 (reasoning, best)");
				addModel("gpt-5-mini",       "GPT-5 Mini (reasoning, faster)");
				addModel("gpt-5-nano",       "GPT-5 Nano (fast / affordable)");
				addModel("gpt-5-search-api", "GPT-5 Search (web search)");
				addModel("gpt-4o",           "GPT-4o (web search)");
				addModel("gpt-4o-mini",      "GPT-4o Mini (web search)");
				addModel("gpt-4-turbo",      "GPT-4 Turbo");

				d.addOption("__claude_header__", "--- Anthropic ---");
				addModel("claude-opus-4-5",   "Claude Opus 4.5 (best)");
				addModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (recommended)");
				addModel("claude-haiku-4-5",  "Claude Haiku 4.5 (fast / affordable)");

				d.addOption("__ollama_header__", "--- Ollama (local) ---");
				for (const model of ollamaModels) addModel(model, model);
				if (ollamaModels.length === 0) {
					d.addOption("__ollama_empty__", "(no models - click Refresh)");
				}

				if (!knownModels.has(currentModel)) addModel(currentModel, currentModel);
				d.setValue(currentModel);

				d.onChange(async (value: string) => {
					if (value.startsWith("__")) {
						d.setValue(currentModel);
						return;
					}

					const provider = detectProvider(value);
					this.plugin.settings.provider = provider;
					if (provider === "openai") {
						this.plugin.settings.model = value;
					} else if (provider === "anthropic") {
						this.plugin.settings.claudeModel = value;
					} else {
						this.plugin.settings.ollamaModel = value;
					}

					await this.plugin.saveSettings();
					this.display();
				});

				return d;
			})
			.addButton(btn => btn
				.setButtonText("Refresh Ollama")
				.setTooltip("Fetch available models from local Ollama server")
				.onClick(() => {
					this.refreshOllamaModelsInSelector()
						.catch((err: unknown) => {
							const message = err instanceof Error ? err.message : String(err);
							console.error("Ollama refresh failed:", err);
							new Notice(`Ollama refresh failed: ${message}`, 6000);
						});
				}),
			);

		new Setting(el)
			.setName("Auto-detect provider")
			.setDesc("Automatically detect AI provider from model name: claude-* -> Anthropic, gpt-* -> OpenAI, others -> Ollama.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoDetectProvider)
				.onChange(async (value: boolean) => {
					this.plugin.settings.autoDetectProvider = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		const activeProvider = this.plugin.settings.autoDetectProvider
			? detectProvider(currentModel)
			: this.plugin.settings.provider;
		this.renderActiveApiKey(el, activeProvider);
	}

	private getOllamaModelOptions(): string[] {
		const models = [...this.ollamaModels];
		const current = this.plugin.settings.ollamaModel?.trim();
		if (current && !models.includes(current)) models.unshift(current);
		return models;
	}

	private getCurrentActiveModel(): string {
		const provider = this.plugin.settings.provider;
		if (provider === "anthropic") return this.plugin.settings.claudeModel ?? "claude-sonnet-4-5";
		if (provider === "ollama") return this.plugin.settings.ollamaModel ?? "llama3.2";
		return this.plugin.settings.model ?? "gpt-4o";
	}

	private renderActiveApiKey(el: HTMLElement, provider: Provider): void {
		const keysInSync      = this.plugin.settings.apiKeysInSync;
		const extEnabled      = this.plugin.externalStorage.isEnabled;
		const keysStoredLocal = !keysInSync && extEnabled;
		const keysLocation    = keysStoredLocal ? t("settings_key_local") : t("settings_key_sync");

		if (provider === "openai") {
			new Setting(el)
				.setName("OpenAI API Key")
				.setDesc(keysLocation)
				.addText(txt => {
					txt.inputEl.type = "password";
					txt.setPlaceholder("sk-...")
						.setValue(this.plugin.settings.apiKey ?? "")
						.onChange(async (value: string) => {
							this.plugin.settings.apiKey = value.trim();
							await this.plugin.saveSettings();
						});
				});
		} else if (provider === "anthropic") {
			new Setting(el)
				.setName("Anthropic API Key")
				.setDesc(keysLocation)
				.addText(txt => {
					txt.inputEl.type = "password";
					txt.setPlaceholder("sk-ant-...")
						.setValue(this.plugin.settings.claudeApiKey ?? "")
						.onChange(async (value: string) => {
							this.plugin.settings.claudeApiKey = value.trim();
							await this.plugin.saveSettings();
						});
				});
		} else {
			new Setting(el)
				.setName("Ollama Base URL")
				.setDesc("Address of your local Ollama server.")
				.addText(txt => txt
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.ollamaBaseUrl ?? "http://localhost:11434")
					.onChange(async (value: string) => {
						this.plugin.settings.ollamaBaseUrl = value.trim();
						await this.plugin.saveSettings();
					}),
				);
		}
	}

	private async refreshOllamaModelsInSelector(): Promise<void> {
		const baseUrl = this.plugin.settings.ollamaBaseUrl || "http://localhost:11434";
		const models = await fetchOllamaModels(baseUrl);
		this.ollamaModels = models;

		if (models.length === 0) {
			new Notice("No Ollama models found. Is the server running?", 5000);
			this.display();
			return;
		}

		if (!models.includes(this.plugin.settings.ollamaModel ?? "")) {
			this.plugin.settings.ollamaModel = models[0];
			await this.plugin.saveSettings();
		}

		new Notice(`Found ${models.length} Ollama model(s)`, 3000);
		this.display();
	}

	private renderOpenAISettings(el: HTMLElement): void {
		new Setting(el)
			.setName("⚙️ " + t("settings_openai_title") + " — " + t("settings_thinking_name"))
			.setHeading();

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

		new Setting(el)
			.setName(t("settings_max_tokens_title"))
			.setHeading();

		new Setting(el)
			.setName(t("settings_max_tokens_fast_name"))
			.setDesc(t("settings_max_tokens_fast_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "256";
				txt.inputEl.addClass("gpt-settings-input-compact");
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
				txt.inputEl.addClass("gpt-settings-input-compact");
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
				txt.inputEl.addClass("gpt-settings-input-compact");
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
		new Setting(el)
			.setName("💬 " + t("settings_context_title"))
			.setHeading();

		new Setting(el)
			.setName(t("settings_context_name"))
			.setDesc(t("settings_context_desc"))
			.addText(txt => {
				txt.inputEl.type = "number";
				txt.inputEl.min  = "0";
				txt.inputEl.addClass("gpt-settings-input-compact");
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

	private renderRAG(el: HTMLElement): void {
		new Setting(el)
			.setName(t("settings_rag_title"))
			.setHeading();

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
		this.renderSafeInlineMarkup(info, t("rag_status",
			this.plugin.rag.indexed ? t("rag_indexed") : t("rag_not_indexed"),
			s.files, s.chunks, s.embeddings,
		));

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
		new Setting(el)
			.setName(t("settings_storage_title"))
			.setHeading();

		const isDesktop   = this.plugin.externalStorage.isDesktop;
		const isActive    = this.plugin.externalStorage.isEnabled;
		const currentPath = this.plugin.externalStorage.baseDir
			?? this.plugin.externalStorage.getDefaultPath();

		// Status bar
		const info = el.createEl("div", { cls: "gpt-settings-storage-info" });
		if (!isDesktop) {
			this.renderSafeInlineMarkup(info, t("settings_storage_mobile_full", this.app.vault.configDir));
		} else if (isActive) {
			info.empty();
			info.createEl("strong", { text: t("settings_storage_active") });
			info.createEl("br");
			info.appendChild(info.ownerDocument.createTextNode("Obsidian Sync does not sync this data."));
			info.createEl("br");
			info.createEl("br");
			info.createEl("strong", { text: "Location:" });
			info.createEl("br");
			const pathEl = info.createEl("code", { text: currentPath });
			pathEl.addClass("gpt-settings-storage-path");
		} else {
			this.renderSafeInlineMarkup(info, t("settings_storage_inactive_html"));
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
				txt.inputEl.addClass("gpt-settings-input-full");
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
						// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron shell is only available at runtime in Obsidian desktop.
						const { shell } = require("electron") as { shell: { openPath: (p: string) => void } };
						shell.openPath(this.plugin.externalStorage.baseDir ?? "");
					} catch (e) {
						new Notice(t("notice_storage_open_fail", (e as Error)?.message));
					}
				}),
			);
	}
}
