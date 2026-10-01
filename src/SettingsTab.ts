import { App, Notice, PluginSettingTab, SecretComponent, Setting, requireApiVersion } from "obsidian";
import { t, setLanguage } from "./i18n";
import { DEFAULT_SYSTEM_PROMPTS, DEFAULT_LOCAL_OPENAI_URL, DEFAULT_LOCAL_OLLAMA_URL } from "./settings";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, detectProvider, getCatalogModels } from "./models";
import { fetchLocalModels, normalizeLocalBaseUrl } from "./api/local";
import { FILE_API_KEYS } from "./constants";
import { debounce } from "./utils";
import { assessLocalBaseUrl } from "./security/urlPolicy";
import { sanitizeErrorDetail } from "./security/redact";
import { ConfirmModal } from "./views/ConfirmModal";
import { EmbeddingsConsentModal } from "./views/EmbeddingsConsentModal";
import type { BaseUrlAssessment } from "./security/urlPolicy";
import type { SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";
import type { ExternalStorage } from "./storage/ExternalStorage";
import type { HistoryManager }  from "./history/HistoryManager";
import type { ProjectManager }  from "./history/ProjectManager";
import type { RAGEngine }       from "./rag/RAGEngine";
import type { GPTHistoryView }  from "./views/HistoryView";
import type { GPTProjectsView } from "./views/ProjectsView";
import { SECRET_NAME_FIELD } from "./security/keyStore";
import type { KeyField, SecretBackend } from "./security/keyStore";
import type { LocalApiType, PluginSettings, Provider } from "./settings";

// ─── Plugin interface ──────────────────────────────────────────────────────────

interface PluginWithDeps {
	app:             App;
	settings:        PluginSettings;
	externalStorage: ExternalStorage;
	history:         HistoryManager;
	projects:        ProjectManager;
	rag:             RAGEngine;
	keysInSecretStorage: boolean;
	readonly secretBackend: SecretBackend | null;
	readSecret(name: string): string;
	useSecretStorage(): Promise<boolean>;
	saveSettings():  Promise<void>;
	loadData():      Promise<Record<string, unknown>>;
	saveData(data: Record<string, unknown>): Promise<void>;
	getHistoryView():  GPTHistoryView | null;
	getProjectsView(): GPTProjectsView | null;
	getChatView(): { refreshNoteTools(): void } | null;
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

	/** Pending write for free-text fields, which fire onChange on every keystroke. */
	private saveTimer: number | null = null;

	/** Live banner under the Base URL field; recreated on every render. */
	private baseUrlWarningEl: HTMLElement | null = null;
	/** Last verdict a Notice was shown for, so typing does not spam the user. */
	private lastWarnedBaseUrlVerdict: string | null = null;

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
			this.chatGroup(),
			this.ragGroup(),
			this.noteEditingGroup(),
			this.storageGroup(),
			this.advancedGroup(),
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

	/**
	 * Saves shortly after the user stops typing. The setting itself is already
	 * updated in memory; only the write to disk waits.
	 */
	private saveSoon(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, 400);
	}

	private async saveNow(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			await this.plugin.saveSettings();
		} catch (e) {
			console.error("[AI-Vault] Failed to save settings:", (e as Error)?.message);
		}
	}

	/** Closing the tab must not lose what was typed in the last 400 ms. */
	hide(): void {
		if (this.saveTimer !== null) void this.saveNow();
		super.hide();
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

	/** Says where the keys are right now — the answer depends on the storage in use. */
	private keyWarningRow(): SettingDefinitionRender {
		const { settings, keysInSecretStorage, externalStorage } = this.plugin;
		const inSecretStorage = keysInSecretStorage && !settings.apiKeysInSync;
		const key =
			inSecretStorage            ? "settings_keys_where_secret_html" :
			settings.apiKeysInSync     ? "settings_keys_where_sync_html" :
			externalStorage.isEnabled  ? "settings_keys_where_file_html" :
			"settings_keys_local_warning_html";

		return this.bannerRow(inSecretStorage ? "gpt-settings-note" : "gpt-settings-warning", el => {
			this.renderSafeInlineMarkup(el, t(key));
		});
	}

	/**
	 * Key field backed by SecretStorage. The setting stores the name of the
	 * secret; Obsidian's own component handles entering and picking the value.
	 */
	private secretKeyRow(name: string, desc: string, field: KeyField): SettingDefinitionRender {
		const nameField = SECRET_NAME_FIELD[field];
		return {
			name,
			desc,
			render: (setting: Setting) => {
				// Only reached when SecretStorage is in use; the check also tells the
				// linter that these newer APIs are never called on an older Obsidian.
				if (requireApiVersion("1.11.4")) {
					setting.addComponent(el => new SecretComponent(this.app, el)
						.setValue(this.plugin.settings[nameField] ?? "")
						.onChange((secretName: string) => {
							this.plugin.settings[nameField] = secretName;
							this.plugin.settings[field] = this.plugin.readSecret(secretName);
							this.saveSoon();
						}),
					);
				}
			},
		};
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
							await this.setKeySync(v);
						} catch (e) {
							console.error("[AI-Vault] Failed to change API key sync setting:", (e as Error)?.message);
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

	/** Moves the keys between data.json (synced) and local storage (not synced). */
	private async setKeySync(sync: boolean): Promise<void> {
		const { plugin } = this;
		const canUseSecrets = plugin.secretBackend !== null;

		// Without SecretStorage, local-only keys need a working folder outside the
		// vault. Try to initialize it here instead of permanently disabling the toggle.
		if (!sync && !canUseSecrets && !plugin.externalStorage.isEnabled) {
			if (!plugin.settings.externalStorageEnabled) {
				new Notice(t("notice_keys_need_external"), 6000);
				return;
			}
			if (!(await plugin.externalStorage.init())) {
				new Notice(t("notice_storage_init_failed", plugin.externalStorage.lastError ?? "unknown error"), 7000);
				return;
			}
		}

		plugin.settings.apiKeysInSync = sync;

		if (sync) {
			// The keys in memory are written into data.json by saveSettings().
			plugin.keysInSecretStorage = false;
			await plugin.saveSettings();
			if (plugin.externalStorage.isEnabled) {
				await plugin.externalStorage.remove(plugin.externalStorage.resolve(FILE_API_KEYS));
			}
			new Notice(t("notice_keys_moved_sync"), 5000);
			return;
		}

		if (await plugin.useSecretStorage() || plugin.keysInSecretStorage) {
			await plugin.saveSettings();
			new Notice(t("notice_keys_moved_secret"), 5000);
			return;
		}

		// SecretStorage is missing or refused the keys, so they need the key file
		// outside the vault. Without it the keys must stay in data.json: removing
		// them from there would leave no copy at all.
		if (!plugin.externalStorage.isEnabled
			&& !(plugin.settings.externalStorageEnabled && await plugin.externalStorage.init())) {
			plugin.settings.apiKeysInSync = true;
			await plugin.saveSettings();
			new Notice(t("notice_keys_need_external"), 6000);
			return;
		}

		// Keys go to keys.json, then leave data.json.
		await plugin.saveSettings();
		const d = await plugin.loadData();
		if (d) {
			delete d.apiKey;
			delete d.claudeApiKey;
			delete d.localApiKey;
			await plugin.saveData(d);
		}
		new Notice(t("notice_keys_moved_local"), 5000);
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
					for (const entry of getCatalogModels("openai")) {
						addModel(entry.id, `${entry.label} (${t(entry.descKey)})`);
					}

					d.addOption("__claude_header__", "--- Anthropic ---");
					for (const entry of getCatalogModels("anthropic")) {
						addModel(entry.id, `${entry.label} (${t(entry.descKey)})`);
					}

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

		return {
			type: "group",
			heading: t("settings_model_heading"),
			items: [providerRow, activeModelRow, ...this.activeApiKeyRows()],
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
		if (provider === "anthropic") return this.plugin.settings.claudeModel ?? DEFAULT_CLAUDE_MODEL;
		if (provider === "local") return this.plugin.settings.localModel?.trim() ?? "";
		return this.plugin.settings.model ?? DEFAULT_OPENAI_MODEL;
	}

	private activeApiKeyRows(): SettingDefinitionRender[] {
		const provider        = this.plugin.settings.provider;
		const keysInSync      = this.plugin.settings.apiKeysInSync;
		const extEnabled      = this.plugin.externalStorage.isEnabled;
		const keysStoredLocal = !keysInSync && extEnabled;
		const keysLocation    = keysStoredLocal ? t("settings_key_local") : t("settings_key_sync");

		if (this.plugin.keysInSecretStorage && !keysInSync) {
			if (provider === "openai") {
				return [this.secretKeyRow(t("settings_openai_key_name"), t("settings_key_secret"), "apiKey")];
			}
			if (provider === "anthropic") {
				return [this.secretKeyRow(t("settings_claude_key_name"), t("settings_key_secret"), "claudeApiKey")];
			}
			return [];
		}

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
								this.saveSoon();
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
								this.saveSoon();
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
							this.saveSoon();
							// The Base URL decides where messages, note excerpts and RAG
							// chunks are sent, so the verdict is recomputed on every edit.
							this.refreshBaseUrlWarning(true);
						});
					txt.inputEl.addClass("gpt-settings-input-full");
				});
			},
		};

		// Persistent verdict banner: plain HTTP to anything that is not a real
		// loopback address means chat content leaves the machine unencrypted.
		const baseUrlWarningRow = this.bannerRow("gpt-settings-warning", el => {
			this.baseUrlWarningEl = el;
			this.refreshBaseUrlWarning(false);
		});

		const useSecrets = this.plugin.keysInSecretStorage && !this.plugin.settings.apiKeysInSync;
		const apiKeyRow: SettingDefinitionRender = useSecrets ? this.secretKeyRow(
			t("settings_local_api_key_name"),
			t("settings_local_api_key_desc") + " " + t("settings_key_secret"),
			"localApiKey",
		) : {
			name: t("settings_local_api_key_name"),
			desc: t("settings_local_api_key_desc"),
			render: (setting: Setting) => {
				setting.addText(txt => {
					txt.inputEl.type = "password";
					txt.setValue(this.plugin.settings.localApiKey ?? "")
						.onChange(async (value: string) => {
							this.plugin.settings.localApiKey = value.trim();
							this.saveSoon();
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
								// The error can carry a fragment of the endpoint's response,
								// so it is sanitized before it reaches the console or a Notice.
								const message = sanitizeErrorDetail(err) || t("settings_local_refresh_generic");
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
			items: [descRow, typeRow, baseUrlRow, baseUrlWarningRow, apiKeyRow, refreshRow, modelRow],
		};
	}

	// ── Base URL verdict ───────────────────────────────────────────────────────

	/** Current verdict for the configured Base URL. */
	private assessBaseUrl(): BaseUrlAssessment {
		return assessLocalBaseUrl(normalizeLocalBaseUrl(
			this.plugin.settings.localBaseUrl ?? "",
			this.plugin.settings.localApiType,
		));
	}

	/**
	 * Repaints the banner under the Base URL field and, when `notify` is set,
	 * raises a one-shot Notice as the verdict changes. The Notice is what makes
	 * the warning visible when the settings tab is not the focused element.
	 */
	private refreshBaseUrlWarning(notify: boolean): void {
		const el = this.baseUrlWarningEl;
		const assessment = this.assessBaseUrl();
		const message = this.baseUrlWarningText(assessment);

		if (el) {
			el.empty();
			el.toggleClass("gpt-ctx-hidden", message === null);
			if (message !== null) el.setText(message);
		}

		if (!notify) {
			this.lastWarnedBaseUrlVerdict = message === null ? null : assessment.verdict;
			return;
		}

		const key = message === null ? null : assessment.verdict;
		if (key !== this.lastWarnedBaseUrlVerdict) {
			this.lastWarnedBaseUrlVerdict = key;
			if (message !== null) new Notice(message, 8000);
		}
	}

	/** Warning text for a verdict, or null when nothing needs to be said. */
	private baseUrlWarningText(assessment: BaseUrlAssessment): string | null {
		if (assessment.reason === "empty") return null;

		if (!assessment.usable) {
			return assessment.reason === "forbidden-scheme"
				? t("settings_local_baseurl_bad_scheme", assessment.protocol ?? "?")
				: t("settings_local_baseurl_invalid");
		}
		if (assessment.verdict === "remote-http") {
			return t("settings_local_baseurl_remote_http", assessment.hostname ?? "?");
		}
		if (assessment.hasEmbeddedCredentials) {
			return t("settings_local_baseurl_credentials");
		}
		return null;
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
								this.saveSoon();
							}
						});
				});
			},
		};
	}

	private chatGroup(): SettingDefinitionGroup {
		const thinkingRow: SettingDefinitionRender = {
			name: t("settings_thinking_name"),
			desc: t("settings_thinking_desc"),
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
		};

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
								this.saveSoon();
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
			heading: t("settings_chat_title"),
			items: [thinkingRow, systemPromptRow],
		};
	}

	// ── Advanced ───────────────────────────────────────────────────────────────

	/** Limits most people never change, kept out of the way at the bottom. */
	private advancedGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: t("settings_advanced_title"),
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
				this.contextLimitRow(),
			],
		};
	}

	private contextLimitRow(): SettingDefinitionRender {
		return {
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
								this.saveSoon();
							}
						});
				});
			},
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

		const hasOpenAIKey = Boolean(this.plugin.settings.apiKey?.trim());
		const semanticRow: SettingDefinitionRender = {
			name: t("settings_rag_semantic_name"),
			desc: t("settings_rag_semantic_desc")
				+ (hasOpenAIKey ? "" : " " + t("settings_rag_semantic_nokey")),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.ragEmbeddingsEnabled === true)
					.onChange((v: boolean) => {
						if (v === (this.plugin.settings.ragEmbeddingsEnabled === true)) return;
						if (v) this.requestEmbeddingsConsent();
						else void this.setEmbeddingsEnabled(false);
					}),
				);
			},
		};

		const storedEmbeddings = this.plugin.rag.stats.embeddings;
		const clearEmbeddingsRow: SettingDefinitionRender = {
			name: t("settings_rag_clear_name"),
			desc: t("settings_rag_clear_desc", storedEmbeddings),
			visible: () => this.plugin.rag.stats.embeddings > 0,
			render: (setting: Setting) => {
				setting.addButton(b => b
					.setButtonText(t("settings_rag_clear_btn"))
					.setClass("mod-warning")
					.onClick(() => {
						new ConfirmModal(
							this.app,
							t("settings_rag_clear_confirm"),
							async () => {
								const removed = await this.plugin.rag.clearEmbeddings();
								new Notice(t("notice_embeddings_cleared", removed));
								this.rerender();
							},
							t("settings_rag_clear_btn"),
							t("chat_notes_cancel"),
						).open();
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
							this.saveSoon();
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
			items: [
				enableRow, autoIndexRow, semanticRow, ignoredPathsRow,
				statusRow, reindexRow, clearEmbeddingsRow,
			],
		};
	}

	// ── Note editing ───────────────────────────────────────────────────────────

	private noteEditingGroup(): SettingDefinitionGroup {
		const enableRow: SettingDefinitionRender = {
			name: t("settings_edit_enable_name"),
			desc: t("settings_edit_enable_desc"),
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.noteEditingEnabled === true)
					.onChange(async (v: boolean) => {
						this.plugin.settings.noteEditingEnabled = v;
						// Switching off puts both safeguards back, so switching on again starts safe.
						if (!v) {
							this.plugin.settings.noteEditingAutoApply = false;
							this.plugin.settings.noteEditingRequireMark = true;
							this.plugin.settings.noteEditingFollowLinks = false;
						}
						await this.plugin.saveSettings();
						this.plugin.getChatView()?.refreshNoteTools();
						this.rerender();
					}),
				);
			},
		};

		const autoApplyRow: SettingDefinitionRender = {
			name: t("settings_edit_auto_name"),
			desc: t("settings_edit_auto_desc"),
			visible: () => this.plugin.settings.noteEditingEnabled === true,
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.noteEditingAutoApply === true)
					.onChange(async (v: boolean) => {
						this.plugin.settings.noteEditingAutoApply = v;
						await this.plugin.saveSettings();
						this.plugin.getChatView()?.refreshNoteTools();
					}),
				);
			},
		};

		const requireMarkRow: SettingDefinitionRender = {
			name: t("settings_edit_mark_name"),
			desc: t("settings_edit_mark_desc"),
			visible: () => this.plugin.settings.noteEditingEnabled === true,
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.noteEditingRequireMark !== false)
					.onChange(async (v: boolean) => {
						this.plugin.settings.noteEditingRequireMark = v;
						await this.plugin.saveSettings();
						this.plugin.getChatView()?.refreshNoteTools();
						this.rerender();
					}),
				);
			},
		};

		const followLinksRow: SettingDefinitionRender = {
			name: t("settings_edit_links_name"),
			desc: t("settings_edit_links_desc"),
			visible: () => this.plugin.settings.noteEditingEnabled === true
				&& this.plugin.settings.noteEditingRequireMark !== false,
			render: (setting: Setting) => {
				setting.addToggle(tog => tog
					.setValue(this.plugin.settings.noteEditingFollowLinks === true)
					.onChange(async (v: boolean) => {
						this.plugin.settings.noteEditingFollowLinks = v;
						await this.plugin.saveSettings();
						this.plugin.getChatView()?.refreshNoteTools();
					}),
				);
			},
		};

		return {
			type: "group",
			heading: t("settings_edit_title"),
			items: [enableRow, requireMarkRow, followLinksRow, autoApplyRow],
		};
	}

	/** Semantic search is only ever switched on from the consent dialog. */
	private requestEmbeddingsConsent(): void {
		new EmbeddingsConsentModal(
			this.app,
			() => this.setEmbeddingsEnabled(true),
			// Declined — redraw so the toggle goes back to off.
			() => this.rerender(),
		).open();
	}

	private async setEmbeddingsEnabled(enabled: boolean): Promise<void> {
		this.plugin.settings.ragEmbeddingsEnabled = enabled;
		await this.plugin.saveSettings();
		new Notice(t(enabled ? "notice_embeddings_enabled" : "notice_embeddings_disabled"), 6000);
		this.rerender();
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
						this.saveSoon();
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
