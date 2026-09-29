/**
 * What the model picker lists, derived from the catalogue and the settings.
 * Free of Obsidian imports, so it is unit tested as written.
 */

import { t } from "../i18n";
import {
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_OPENAI_MODEL,
	findCatalogEntry,
	getCatalogModels,
} from "../models";
import type { PluginSettings, Provider } from "../settings";

export interface ModelOption {
	id:     string;
	label:  string;
	desc:   string;
	legacy: boolean;
}

export interface ModelGroup {
	provider: Provider;
	title:    string;
	models:   ModelOption[];
}

type ModelSettings = Pick<
	PluginSettings,
	"provider" | "model" | "claudeModel" | "localModel" | "localModelsCache"
>;

const PROVIDERS: readonly Provider[] = ["openai", "anthropic", "local"];

export function getActiveModel(settings: ModelSettings): string {
	if (settings.provider === "anthropic") return settings.claudeModel ?? DEFAULT_CLAUDE_MODEL;
	if (settings.provider === "local") return settings.localModel?.trim() ?? "";
	return settings.model ?? DEFAULT_OPENAI_MODEL;
}

export function getProviderLabel(provider: Provider): string {
	if (provider === "anthropic") return "Claude";
	if (provider === "local") return "Local API";
	return "GPT";
}

export function getProviderIcon(provider: Provider): string {
	if (provider === "anthropic") return "🟣";
	if (provider === "local") return "🖥️";
	return "🤖";
}

export function formatModelLabel(model: string): string {
	return findCatalogEntry(model)?.label ?? model;
}

function groupTitle(provider: Provider): string {
	if (provider === "anthropic") return t("chat_picker_claude");
	if (provider === "local") return t("chat_picker_ollama");
	return t("chat_picker_openai");
}

function modelsFor(provider: Provider, settings: ModelSettings): ModelOption[] {
	if (provider !== "local") {
		return getCatalogModels(provider).map(entry => ({
			id:     entry.id,
			label:  entry.label,
			desc:   t(entry.descKey),
			legacy: entry.legacy,
		}));
	}

	const models  = [...(settings.localModelsCache ?? [])];
	const current = settings.localModel?.trim();
	if (current && !models.includes(current)) models.unshift(current);
	return models.map(id => ({ id, label: id, desc: t("model_desc_ollama"), legacy: false }));
}

/** Every provider in one list — picking a model also picks its provider. */
export function buildModelGroups(settings: ModelSettings): ModelGroup[] {
	const activeModel = getActiveModel(settings);

	return PROVIDERS.map(provider => {
		const models = modelsFor(provider, settings);
		// A model id typed by hand in settings is not in the catalogue.
		if (provider === settings.provider && activeModel && !models.some(m => m.id === activeModel)) {
			models.unshift({ id: activeModel, label: activeModel, desc: t("model_desc_custom"), legacy: false });
		}
		return { provider, title: groupTitle(provider), models };
	});
}

/** Writes the chosen model into the settings field of its provider. */
export function applyModelChoice(settings: ModelSettings, provider: Provider, model: string): void {
	settings.provider = provider;
	if (provider === "openai") settings.model = model;
	else if (provider === "anthropic") settings.claudeModel = model;
	else settings.localModel = model;
}
