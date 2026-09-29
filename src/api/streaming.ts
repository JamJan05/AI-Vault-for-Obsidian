import { requestUrl } from "obsidian";

import { t } from "../i18n";
import { ModelAccessError } from "../models";
import { sanitizeErrorDetail } from "../security/redact";

export interface StreamUsage {
	input:     number;
	output:    number;
	reasoning: number;
}

export interface StreamResult {
	text:  string;
	usage: StreamUsage | null;
	/** Set when the provider answered with a different model than the one requested. */
	servedBy?: string;
}

interface HttpResponse {
	status: number;
	json:   unknown;
}

type TextExtractor = (response: Record<string, unknown>) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function abortError(): Error {
	const error = new Error("Aborted by user");
	error.name = "AbortError";
	return error;
}

/** An error that withRetry must not repeat: sending the request again cannot help. */
export function nonRetryableError(message: string): Error {
	return Object.assign(new Error(message), { noRetry: true });
}

/**
 * A client error means the request itself was rejected. Repeating it would only
 * send the same conversation again, so only timeouts and rate limits are retried.
 */
function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export function parseUsage(response: Record<string, unknown>): StreamUsage | null {
	if (!isRecord(response.usage)) return null;

	const usage = response.usage;
	const details = isRecord(usage.completion_tokens_details)
		? usage.completion_tokens_details
		: isRecord(usage.output_tokens_details)
			? usage.output_tokens_details
			: null;
	const input = usage.prompt_tokens ?? usage.input_tokens;
	const output = usage.completion_tokens ?? usage.output_tokens;
	const reasoning = details?.reasoning_tokens;

	return {
		input:     typeof input === "number" ? input : 0,
		output:    typeof output === "number" ? output : 0,
		reasoning: typeof reasoning === "number" ? reasoning : 0,
	};
}

/** Throws a provider-aware error for a failed Obsidian requestUrl response. */
export function throwHttpError(response: HttpResponse, modelHint?: string | null): never {
	const statusMsg = `HTTP ${response.status}`;
	let errMsg = statusMsg;
	let errCode: string | null = null;

	if (isRecord(response.json)) {
		const error = isRecord(response.json.error) ? response.json.error : null;
		const raw = (error ? readString(error, "message") : null)
			?? readString(response.json, "message");
		// Provider error strings routinely echo the submitted credential back
		// ("Incorrect API key provided: sk-…"), so they are sanitized before they
		// can reach a Notice, the console, or an exported conversation.
		errMsg = sanitizeErrorDetail(raw) || statusMsg;
		errCode = (error ? readString(error, "code") : null)
			?? (error ? readString(error, "type") : null);
	}

	if (response.status === 403 || response.status === 404 || errCode === "model_not_found") {
		throw new ModelAccessError(errMsg, {
			model:  modelHint ?? undefined,
			status: response.status,
			code:   errCode ?? undefined,
		});
	}

	throw isRetryableStatus(response.status) ? new Error(errMsg) : nonRetryableError(errMsg);
}

/**
 * Sends one provider request through Obsidian's requestUrl API and returns the
 * validated JSON object. requestUrl does not expose SSE streams, so every
 * provider is asked for a single, complete JSON response.
 */
export async function requestJson(
	url:     string,
	headers: Record<string, string>,
	body:    Record<string, unknown>,
	signal?: AbortSignal | null,
): Promise<Record<string, unknown>> {
	if (signal?.aborted) throw abortError();

	const requestBody: Record<string, unknown> = { ...body, stream: false };
	delete requestBody.stream_options;

	const request = requestUrl({
		url,
		method:  "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body:    JSON.stringify(requestBody),
		throw:   false,
	});
	let abortHandler: (() => void) | null = null;
	const aborted = new Promise<never>((_resolve, reject) => {
		abortHandler = () => reject(abortError());
		signal?.addEventListener("abort", abortHandler, { once: true });
	});

	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = signal ? await Promise.race([request, aborted]) : await request;
	} finally {
		if (abortHandler) signal?.removeEventListener("abort", abortHandler);
	}

	if (signal?.aborted) throw abortError();
	if (response.status < 200 || response.status >= 300) {
		const model = typeof body.model === "string" ? body.model : null;
		throwHttpError({ status: response.status, json: response.json }, model);
	}
	if (!isRecord(response.json)) throw new Error(t("err_empty_response"));

	const providerError = isRecord(response.json.error) ? response.json.error : null;
	if (providerError || response.json.type === "error") {
		const raw = (providerError ? readString(providerError, "message") : null)
			?? readString(response.json, "message");
		throw new Error(sanitizeErrorDetail(raw) || t("err_stream"));
	}

	return response.json;
}

/**
 * Sends a provider request and extracts the answer text.
 * `onChunk` is called once, with the complete answer.
 */
export async function requestCompletion(
	url:          string,
	headers:      Record<string, string>,
	body:         Record<string, unknown>,
	extractText: TextExtractor,
	onChunk:      ((fullText: string) => void) | null,
	signal?:      AbortSignal | null,
): Promise<StreamResult> {
	const json = await requestJson(url, headers, body, signal);

	const text = extractText(json)?.trim() ?? "";
	if (!text) throw new Error(t("err_empty_response"));

	onChunk?.(text);
	return { text, usage: parseUsage(json) };
}
