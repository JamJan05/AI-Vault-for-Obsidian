import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t, setLanguage } from "./i18n";
import { DEFAULT_SYSTEM_PROMPTS, DEFAULT_LOCAL_OPENAI_URL, DEFAULT_LOCAL_OLLAMA_URL } from "./settings";
import { detectProvider } from "./models";
import { fetchLocalModels, normalizeLocalBaseUrl } from "./api/local";
import { FILE_API_KEYS } from "./constants";
import { debounce } from "./utils";
import type { SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";
import type { ExternalStorage } from "./storage/ExternalStorage";
import type { HistoryManager }  from "./history/HistoryManager";
import type { ProjectManager }  from "./history/ProjectManager";
import type { RAGEngine }       from "./rag/RAGEngine";
import type { GPTHistoryView }  from "./views/HistoryView";
import type { GPTProjectsView } from "./views/ProjectsView";
import type { LocalApiType, PluginSettings, Provider } from "./settings";

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

function isProvider(value: string): value is Provider {
	return value === "openai" || value === "anthropic" || value === "local";
}

function isLocalApiType(value: string): value is LocalApiType {
	return value === "openai-compatible" || value === "ollama";
}

/** Only groups and imperative rows are produced here — pages and lists are not used. */
function isDefinitionGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
	const type = (item as SettingDefinitionGroup).type;
	return type === "group" || type === "list";
}

function isVisible(value: boolean | (() => boolean) | undefined): boolean {
	if (value === undefined) return true;
	return typeof value === "function" ? value() : value;
}

// ─── SettingsTab ───────────────────────────────────────────────────────────────

export class GPTSettingsTab extends PluginSettingTab {
	/**
	 * Purging the index is O(index size), while onChange fires per keystroke — so the
	 * setting is saved immediately and the index is swept once the user stops typing.
	 */
	private readonly purgeIgnoredRagPaths = debounce(() => this.plugin.rag.applyIgnorePatterns(), 800);

	constructor(app: App, private readonly plugin: PluginWithDeps) {
		super(app, plugin as never);
	}

	// ── Entry points ───────────────────────────────────────────────────────────

	/**
	 * Single source of truth for the tab. Obsidian 1.13+ renders from this and
	 * indexes `name` / `desc` for the settings search.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.headingRow(t("settings_title")),
			this.languageRow(),
			this.keyWarningRow(),
			...this.apiKeySyncRows(),
			this.modelGroup(),
			this.localApiGroup(),
			this.thinkingGroup(),
			this.maxTokensGroup(),
			this.contextGroup(),
			this.ragGroup(),
			this.storageGroup(),
		];
	}

	/**
	 * Fallback for Obsidian versions older than 1.13, which do not call
	 * getSettingDefinitions(). Renders exactly the same definitions imperatively,
	 * so the two paths cannot drift apart.
	 */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingDefinitions()) this.displayLegacyItem(containerEl, item);
	}

	private displayLegacyItem(container: HTMLElement, item: SettingDefinitionItem): void {
		if (!isVisible((item as SettingDefinitionGroup).visible)) return;

		if (isDefinitionGroup(item)) {
			if (item.heading) new Setting(container).setName(item.heading).setHeading();
			for (const child of item.items ?? []) this.displayLegacyItem(container, child);
			return;
		}

		const setting = new Setting(container);
		if (item.name) setting.setName(item.name);
		if (item.desc) setting.setDesc(item.desc);
		const render = (item as SettingDefinitionRender).render;
		// The group argument is never read by the callbacks defined below.
		if (render) render(setting, undefined as never);
	}

	/**
	 * Rebuilds the tab after a change that alters which rows exist. Obsidian 1.13+
	 * re-renders from the definitions; older versions only know display().
	 */
	private rerender(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.renderLegacy();
	}

	// ── Row helpers ────────────────────────────────────────────────────────────

	private headingRow(text: string): SettingDefinitionRender {
		return {
			name: text,
			searchable: false,
			render: (setting: Setting) => {
				setting.setName(text).setHeading();
			},
		};
	}

	/**
	 * A full-width informational block. The row element is stripped back to a plain
	 * div so the existing banner styling applies unchanged.
	 */
	private bannerRow(
		cls: string,
		build: (el: HTMLElement) => void,
		visible?: () => boolean,
	): SettingDefinitionRender {
		return {
			name: "",
			searchable: false,
			visible,
			render: (setting: Setting) => {
				const el = setting.settingEl;
				el.empty();
				el.removeClass("setting-item");
				el.addClass(cls);
				build(el);
			},
		};
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

	// ── Language and API keys ──────────────────────────────────────────────────

	private languageRow(): SettingDefinitionRender {
		// Always in English — understandable regardless of the current language
		return {
			name: "Language / Język",
			desc: "Plugin interface language / Język interfejsu wtyczki",
			render: (setting: Setting) => {
				setting.addDropdown(d => d
					.addOption("en", "🇬🇧 English")
					.addOption("pl", "🇵🇱 Polski")
					.setValue(this.plugin.settings.language ?? "en")
					.onChange(async (v: string) => {
						this.plugin.settings.language = v as "en" | "pl";
						await this.plugin.saveSettings();
						setLanguage(v, this.plugin);
						this.rerender();
					}),
				);
			},
		};
	}

	private keyWarningRow(): SettingDefinitionRender {
		return this.bannerRow("gpt-settings-warning", el => {
			this.renderSafeInlineMarkup(el, t("settings_keys_local_warning_html"));
		});
	}

	private apiKeySyncRows(): SettingDefinitionItem[] {
		const keysInSync = this.plugin.settings.apiKeysInSync;
		const isDesktop  = this.plugin.externalStorage.isDesktop;

		const toggleRow: SettingDefinitionRender = {
			name: t("settings_keys_sync_name"),
			desc: keysInSync ? t("settings_keys_sync_desc_on") : t("settings_keys_sync_desc_off"),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(keysInSync)
					.setDisabled(!isDesktop)
					.onChange(async (v: boolean) => {
						tog.setDisabled(true);
						try {
							// Local-only keys require a working folder outside the vault. Try
							// to initialize it here instead of permanently disabling the toggle.
							if (!v && !this.plugin.externalStorage.isEnabled) {
								if (!this.plugin.settings.externalStorageEnabled) {
									new Notice(t("notice_keys_need_external"), 6000);
									return;
								}
								if (!(await this.plugin.externalStorage.init())) {
									new Notice(t("notice_storage_init_failed", this.plugin.externalStorage.lastError ?? "unknown error"), 7000);
									return;
								}
							}

							const oldApiKey       = this.plugin.settings.apiKey;
							const oldClaudeApiKey = this.plugin.settings.claudeApiKey;
							const oldLocalApiKey  = this.plugin.settings.localApiKey;
							this.plugin.settings.apiKeysInSync = v;
							this.plugin.settings.apiKey        = oldApiKey;
							this.plugin.settings.claudeApiKey  = oldClaudeApiKey;
							this.plugin.settings.localApiKey   = oldLocalApiKey;
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
									delete d.localApiKey;
									await this.plugin.saveData(d);
								}
								new Notice(t("notice_keys_moved_local"), 5000);
							}
						} catch (e) {
							console.error("[AI-Vault] Failed to change API key sync setting:", e);
							new Notice(t("notice_setting_change_failed", (e as Error)?.message ?? String(e)), 7000);
						} finally {
							this.rerender();
						}
					}),
				);
			},
		};

		if (isDesktop) return [toggleRow];

		return [
			toggleRow,
			this.bannerRow("gpt-settings-note", el => {
				el.setText(t("settings_keys_mobile_note"));
			}),
		];
	}

	// ── Model ──────────────────────────────────────────────────────────────────

	private modelGroup(): SettingDefinitionGroup {
		const currentModel = this.getCurrentActiveModel();
		const localModels  = this.getLocalModelOptions();
		const knownModels  = new Set<string>();

		const providerRow: SettingDefinitionRender = {
			name: t("settings_provider_name"),
			desc: t("settings_provider_desc"),
			render: (setting: Setting) => {
				setting.addDropdown(d => d
					.addOption("openai", "OpenAI")
					.addOption("anthropic", "Anthropic")
					.addOption("local", "Local API")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value: string) => {
						if (!isProvider(value)) return;
						this.plugin.settings.provider = value;
						await this.plugin.saveSettings();
						this.rerender();
					}),
				);
			},
		};

		const activeModelRow: SettingDefinitionRender = {
			name: t("settings_active_model_name"),
			desc: t("settings_active_model_desc"),
			render: (setting: Setting) => {
				setting.addDropdown(d => {
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

					d.addOption("__local_header__", "--- Local API ---");
					for (const model of localModels) addModel(model, model);
					if (localModels.length === 0) {
						d.addOption("__local_empty__", t("settings_local_empty_paren"));
					}

					if (currentModel && !knownModels.has(currentModel)) addModel(currentModel, currentModel);
					d.setValue(currentModel || "__local_empty__");

					d.onChange(async (value: string) => {
						if (value.startsWith("__")) {
							d.setValue(currentModel || "__local_empty__");
							return;
						}

						const provider = localModels.includes(value) ? "local" : detectProvider(value);
						this.plugin.settings.provider = provider;
						if (provider === "openai") {
							this.plugin.settings.model = value;
						} else if (provider === "anthropic") {
							this.plugin.settings.claudeModel = value;
						} else {
							this.plugin.settings.localModel = value;
						}

						await this.plugin.saveSettings();
						this.rerender();
					});

					return d;
				});
			},
		};

		const autoDetectRow: SettingDefinitionRender = {
			name: t("settings_autodetect_name"),
			desc: t("settings_autodetect_desc"),
			render: (setting: Setting) => {
				setting.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoDetectProvider)
					.onChange(async (value: boolean) => {
						this.plugin.settings.autoDetectProvider = value;
						await this.plugin.saveSettings();
						this.rerender();
					}),
				);
			},
		};

		return {
			type: "group",
			heading: t("settings_model_heading"),
			items: [providerRow, activeModelRow, autoDetectRow, ...this.activeApiKeyRows()],
		};
	}

	private getLocalModelOptions(): string[] {
		const models  = [...(this.plugin.settings.localModelsCache ?? [])];
		const current = this.plugin.settings.localModel?.trim();
		if (current && !models.includes(current)) models.unshift(current);
		return models;
	}

	private getCurrentActiveModel(): string {
		const provider = this.plugin.settings.provider;
		if (provider === "anthropic") return this.plugin.settings.claudeModel ?? "claude-sonnet-4-5";
		if (provider === "local") return this.plugin.settings.localModel?.trim() ?? "";
		return this.plugin.settings.model ?? "gpt-4o";
	}

	private activeApiKeyRows(): SettingDefinitionRender[] {
		const provider        = this.plugin.settings.provider;
		const keysInSync      = this.plugin.settings.apiKeysInSync;
		const extEnabled      = this.plugin.externalStorage.isEnabled;
		const keysStoredLocal = !keysInSync && extEnabled;
		const keysLocation    = keysStoredLocal ? t("settings_key_local") : t("settings_key_sync");

		if (provider === "openai") {
			return [{
				name: t("settings_openai_key_name"),
				desc: keysLocation,
				render: (setting: Setting) => {
					setting.addText(txt => {
						txt.inputEl.type = "password";
						txt.setPlaceholder("sk-...")
							.setValue(this.plugin.settings.apiKey ?? "")
							.onChange(async (value: string) => {
								this.plugin.settings.apiKey = value.trim();
								await this.plugin.saveSettings();
							});
					});
				},
			}];
		}

		if (provider === "anthropic") {
			return [{
				name: t("settings_claude_key_name"),
				desc: keysLocation,
				render: (setting: Setting) => {
					setting.addText(txt => {
						txt.inputEl.type = "password";
						txt.setPlaceholder("sk-ant-...")
							.setValue(this.plugin.settings.claudeApiKey ?? "")
							.onChange(async (value: string) => {
								this.plugin.settings.claudeApiKey = value.trim();
								await this.plugin.saveSettings();
							});
					});
				},
			}];
		}

		return [];
	}

	// ── Local API ──────────────────────────────────────────────────────────────

	private localApiGroup(): SettingDefinitionGroup {
		const localType   = this.plugin.settings.localApiType;
		const placeholder = this.getDefaultLocalBaseUrl(localType);
		const localModels = this.getLocalModelOptions();

		const descRow = this.bannerRow("gpt-settings-note", el => {
			el.setText(t("settings_local_desc"));
		});

		const typeRow: SettingDefinitionRender = {
			name: t("settings_local_type_name"),
			render: (setting: Setting) => {
				setting.addDropdown(d => d
					.addOption("openai-compatible", "OpenAI-compatible")
					.addOption("ollama", "Ollama")
					.setValue(localType)
					.onChange(async (value: string) => {
						if (!isLocalApiType(value)) return;
						const previousType = this.plugin.settings.localApiType;
						this.plugin.settings.localApiType = value;

						const currentBase = this.plugin.settings.localBaseUrl.trim();
						const previousDefault = this.getDefaultLocalBaseUrl(previousType);
						if (!currentBase || normalizeLocalBaseUrl(currentBase, previousType) === previousDefault) {
							this.plugin.settings.localBaseUrl = this.getDefaultLocalBaseUrl(value);
						}

						await this.plugin.saveSettings();
						this.rerender();
					}),
				);
			},
		};

		const baseUrlRow: SettingDefinitionRender = {
			name: t("settings_local_baseurl_name"),
			desc: t("settings_local_baseurl_desc"),
			render: (setting: Setting) => {
				setting.addText(txt => {
					txt.setPlaceholder(placeholder)
						.setValue(this.plugin.settings.localBaseUrl ?? "")
						.onChange(async (value: string) => {
							this.plugin.settings.localBaseUrl = value.trim();
							await this.plugin.saveSettings();
						});
					txt.inputEl.addClass("gpt-settings-input-full");
				});
			},
		};

		const apiKeyRow: SettingDefinitionRender = {
			name: t("settings_local_api_key_name"),
			desc: t("settings_local_api_key_desc"),
			render: (setting: Setting) => {
				setting.addText(txt => {
					txt.inputEl.type = "password";
					txt.setValue(this.plugin.settings.localApiKey ?? "")
						.onChange(async (value: string) => {
							this.plugin.settings.localApiKey = value.trim();
							await this.plugin.saveSettings();
						});
					txt.inputEl.addClass("gpt-settings-input-full");
				});
			},
		};

		const refreshRow: SettingDefinitionRender = {
			name: t("settings_local_refresh_name"),
			desc: t("settings_local_refresh_desc"),
			render: (setting: Setting) => {
				setting.addButton(btn => btn
					.setButtonText(t("settings_local_refresh_btn"))
					.setTooltip(t("settings_local_refresh_tip"))
					.onClick(() => {
						btn.setButtonText(t("settings_local_refreshing")).setDisabled(true);
						void this.refreshLocalModelsInSelector()
							.catch((err: unknown) => {
								const message = err instanceof Error ? err.message : String(err);
								console.error("Local API refresh failed:", message);
								new Notice(t("settings_local_refresh_fail", message), 7000);
							})
							.finally(() => {
								btn.setButtonText(t("settings_local_refresh_btn")).setDisabled(false);
							});
					}),
				);
			},
		};

		const modelRow: SettingDefinitionRender = {
			name: t("settings_local_model_name"),
			desc: localModels.length > 0
				? t("settings_local_model_desc_ok")
				: t("settings_local_model_desc_empty"),
			render: (setting: Setting) => {
				setting.addDropdown(d => {
					if (localModels.length === 0) {
						d.addOption("__local_empty__", t("settings_local_model_empty_opt"));
						d.setValue("__local_empty__");
						return d;
					}

					for (const model of localModels) d.addOption(model, model);
					d.setValue(this.plugin.settings.localModel || localModels[0]);
					d.onChange(async (value: string) => {
						if (value.startsWith("__")) return;
						this.plugin.settings.localModel = value;
						await this.plugin.saveSettings();
						this.rerender();
					});
					return d;
				});
			},
		};

		return {
			type: "group",
			heading: t("settings_local_title"),
			visible: () => this.plugin.settings.provider === "local",
			items: [descRow, typeRow, baseUrlRow, apiKeyRow, refreshRow, modelRow],
		};
	}

	private getDefaultLocalBaseUrl(localApiType: LocalApiType): string {
		return localApiType === "ollama" ? DEFAULT_LOCAL_OLLAMA_URL : DEFAULT_LOCAL_OPENAI_URL;
	}

	private async refreshLocalModelsInSelector(): Promise<void> {
		const defaultBaseUrl = this.getDefaultLocalBaseUrl(this.plugin.settings.localApiType);
		const normalizedBaseUrl = normalizeLocalBaseUrl(
			this.plugin.settings.localBaseUrl || defaultBaseUrl,
			this.plugin.settings.localApiType,
		);
		this.plugin.settings.localBaseUrl = normalizedBaseUrl;

		const models = await fetchLocalModels(this.plugin.settings);
		this.plugin.settings.localModelsCache = models;

		if (!this.plugin.settings.localModel?.trim() && models.length > 0) {
			this.plugin.settings.localModel = models[0];
		}

		await this.plugin.saveSettings();
		new Notice(t("settings_local_models_found", models.length), 3000);
		this.rerender();
	}

	// ── Thinking mode and token limits ─────────────────────────────────────────

	private thinkingGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "⚙️ " + t("settings_openai_title") + " — " + t("settings_thinking_name"),
			items: [{
				name: t("settings_thinking_name"),
				render: (setting: Setting) => {
					setting.addDropdown(d => d
						.addOption("fast",   t("chat_mode_fast"))
						.addOption("normal", t("chat_mode_normal"))
						.addOption("think",  t("chat_mode_think"))
						.setValue(this.plugin.settings.thinkingMode)
						.onChange(async (v: string) => {
							this.plugin.settings.thinkingMode = v as "fast" | "normal" | "think";
							await this.plugin.saveSettings();
						}),
					);
				},
			}],
		};
	}

	/** Numeric input shared by the three token limits. */
	private tokenLimitRow(
		name: string,
		desc: string,
		read: () => number,
		write: (value: number) => void,
	): SettingDefinitionRender {
		return {
			name,
			desc,
			render: (setting: Setting) => {
				setting.addText(txt => {
					txt.inputEl.type = "number";
					txt.inputEl.min  = "256";
					txt.inputEl.addClass("gpt-settings-input-compact");
					txt.setValue(String(read()))
						.onChange(async (v: string) => {
							const n = parseInt(v, 10);
							if (!isNaN(n) && n >= 256) {
								write(n);
								await this.plugin.saveSettings();
							}
						});
				});
			},
		};
	}

	private maxTokensGroup(): SettingDefinitionGroup {
		const systemPromptRow: SettingDefinitionRender = {
			name: t("settings_system_prompt_name"),
			desc: t("settings_system_prompt_desc"),
			render: (setting: Setting) => {
				setting
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
							this.rerender();
						}),
					);
			},
		};

		return {
			type: "group",
			heading: t("settings_max_tokens_title"),
			items: [
				this.tokenLimitRow(
					t("settings_max_tokens_fast_name"),
					t("settings_max_tokens_fast_desc"),
					() => this.plugin.settings.maxTokensFast ?? 4096,
					n => { this.plugin.settings.maxTokensFast = n; },
				),
				this.tokenLimitRow(
					t("settings_max_tokens_normal_name"),
					t("settings_max_tokens_normal_desc"),
					() => this.plugin.settings.maxTokensNormal ?? 8192,
					n => { this.plugin.settings.maxTokensNormal = n; },
				),
				this.tokenLimitRow(
					t("settings_max_tokens_think_name"),
					t("settings_max_tokens_think_desc"),
					() => this.plugin.settings.maxTokensThink ?? 16000,
					n => { this.plugin.settings.maxTokensThink = n; },
				),
				systemPromptRow,
			],
		};
	}

	// ── Conversation context ───────────────────────────────────────────────────

	private contextGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "💬 " + t("settings_context_title"),
			items: [{
				name: t("settings_context_name"),
				desc: t("settings_context_desc"),
				render: (setting: Setting) => {
					setting.addText(txt => {
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
				},
			}],
		};
	}

	// ── RAG ────────────────────────────────────────────────────────────────────

	private ragGroup(): SettingDefinitionGroup {
		const enableRow: SettingDefinitionRender = {
			name: t("settings_rag_enable_name"),
			desc: t("settings_rag_enable_desc"),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.ragEnabled)
					.onChange(async (v: boolean) => {
						this.plugin.settings.ragEnabled = v;
						await this.plugin.saveSettings();
					}),
				);
			},
		};

		const autoIndexRow: SettingDefinitionRender = {
			name: t("settings_rag_auto_name"),
			desc: t("settings_rag_auto_desc"),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.ragAutoIndex)
					.onChange(async (v: boolean) => {
						this.plugin.settings.ragAutoIndex = v;
						await this.plugin.saveSettings();
					}),
				);
			},
		};

		const ignoredPathsRow: SettingDefinitionRender = {
			name: t("settings_rag_ignored_name"),
			desc: t("settings_rag_ignored_desc"),
			render: (setting: Setting) => {
				setting.addTextArea(ta => {
					ta.inputEl.rows = 5;
					ta.inputEl.addClass("gpt-settings-input-full");
					ta.setPlaceholder(t("settings_rag_ignored_placeholder"))
						.setValue(this.plugin.settings.ragExcludedPaths ?? "")
						.onChange(async (v: string) => {
							this.plugin.settings.ragExcludedPaths = v;
							await this.plugin.saveSettings();
							this.purgeIgnoredRagPaths();
						});
				});
			},
		};

		const statusRow = this.bannerRow("gpt-settings-rag-status", el => {
			const s = this.plugin.rag.stats;
			this.renderSafeInlineMarkup(el, t("rag_status",
				this.plugin.rag.indexed ? t("rag_indexed") : t("rag_not_indexed"),
				s.files, s.chunks, s.embeddings,
			));
		});

		const reindexRow: SettingDefinitionRender = {
			name: t("settings_rag_reindex_name"),
			render: (setting: Setting) => {
				setting.addButton(b => b
					.setButtonText(t("settings_rag_reindex_btn"))
					.setCta()
					.onClick(async () => {
						b.setButtonText(t("settings_rag_indexing")).setDisabled(true);
						await this.plugin.rag.buildIndex();
						const st = this.plugin.rag.stats;
						new Notice(t("rag_done", st.files));
						b.setButtonText(t("settings_rag_reindex_btn")).setDisabled(false);
						this.rerender();
					}),
				);
			},
		};

		return {
			type: "group",
			heading: t("settings_rag_title"),
			items: [enableRow, autoIndexRow, ignoredPathsRow, statusRow, reindexRow],
		};
	}

	// ── Storage ────────────────────────────────────────────────────────────────

	private storageGroup(): SettingDefinitionGroup {
		const isDesktop   = this.plugin.externalStorage.isDesktop;
		const isActive    = this.plugin.externalStorage.isEnabled;
		const currentPath = this.plugin.externalStorage.baseDir
			?? this.plugin.externalStorage.getDefaultPath();

		const statusRow = this.bannerRow("gpt-settings-storage-info", info => {
			if (!isDesktop) {
				this.renderSafeInlineMarkup(info, t("settings_storage_mobile_full", this.app.vault.configDir));
			} else if (isActive) {
				info.createEl("strong", { text: t("settings_storage_active") });
				info.createEl("br");
				info.appendChild(info.ownerDocument.createTextNode(t("settings_storage_no_sync")));
				info.createEl("br");
				info.createEl("br");
				info.createEl("strong", { text: t("settings_storage_location") });
				info.createEl("br");
				const pathEl = info.createEl("code", { text: currentPath });
				pathEl.addClass("gpt-settings-storage-path");
			} else {
				this.renderSafeInlineMarkup(info, t("settings_storage_inactive_html"));
			}
		});

		const enableRow: SettingDefinitionRender = {
			name: t("settings_storage_name"),
			desc: t("settings_storage_desc"),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.externalStorageEnabled)
					.setDisabled(!isDesktop)
					.onChange(async (v: boolean) => {
						tog.setDisabled(true);
						try {
							this.plugin.settings.externalStorageEnabled = v;
							if (v) {
								if (!(await this.plugin.externalStorage.init())) {
									this.plugin.settings.externalStorageEnabled = false;
									await this.plugin.saveSettings();
									new Notice(t("notice_storage_init_failed", this.plugin.externalStorage.lastError ?? "unknown error"), 7000);
									return;
								}
							} else {
								this.plugin.externalStorage.disable();
							}
							await this.plugin.saveSettings();
							new Notice(t(v ? "notice_storage_enabled" : "notice_storage_disabled"), 5000);
						} catch (e) {
							console.error("[AI-Vault] Failed to change external storage setting:", e);
							new Notice(t("notice_setting_change_failed", (e as Error)?.message ?? String(e)), 7000);
						} finally {
							this.rerender();
						}
					}),
				);
			},
		};

		const defaultPath = this.plugin.externalStorage.getDefaultPath()
			|| t("settings_storage_mobile_na");

		const pathRow: SettingDefinitionRender = {
			name: t("settings_storage_path_name"),
			desc: t("settings_storage_path_desc", defaultPath),
			render: (setting: Setting) => {
				setting.addText(txt => {
					txt.setPlaceholder(t("settings_storage_path_placeholder"))
						.setValue(this.plugin.settings.externalStoragePath ?? "")
						.setDisabled(!isDesktop);
					txt.inputEl.addClass("gpt-settings-input-full");
					txt.onChange(async (v: string) => {
						this.plugin.settings.externalStoragePath = v.trim();
						await this.plugin.saveSettings();
					});
				});
			},
		};

		const migrateRow: SettingDefinitionRender = {
			name: t("settings_storage_migrate_name"),
			desc: t("settings_storage_migrate_desc"),
			render: (setting: Setting) => {
				setting.addButton(b => b
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
							this.rerender();
						}
					}),
				);
			},
		};

		return {
			type: "group",
			heading: t("settings_storage_title"),
			items: [statusRow, enableRow, pathRow, migrateRow],
		};
	}
}
