import { t } from "../i18n";
import { ModelAccessError } from "../models";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreamUsage {
	input:     number;
	output:    number;
	reasoning: number;
}

export interface StreamResult {
	text:  string;
	usage: StreamUsage | null;
}

type DeltaExtractor = (event: Record<string, unknown>) => string | null;

// ─── HTTP error ────────────────────────────────────────────────────────────────

/**
 * Parses an HTTP error response and throws the appropriate Error.
 * ModelAccessError — for 403/404/model_not_found (chat view can then suggest a fallback).
 */
export async function throwHttpError(response: Response, modelHint?: string | null): Promise<never> {
	let errMsg  = `HTTP ${response.status}`;
	let errCode: string | null = null;

	try {
		const d = await response.json() as {
			error?: { message?: string; code?: string; type?: string };
			message?: string;
		};
		errMsg  = d?.error?.message ?? d?.message ?? errMsg;
		errCode = d?.error?.code    ?? d?.error?.type ?? null;
	} catch { /* ignore — body may be empty */ }

	if (
		response.status === 403 ||
		response.status === 404 ||
		errCode === "model_not_found"
	) {
		throw new ModelAccessError(errMsg, {
			model:  modelHint ?? undefined,
			status: response.status,
			code:   errCode ?? undefined,
		});
	}

	throw new Error(errMsg);
}

// ─── SSE streaming ────────────────────────────────────────────────────────────

/**
 * Unified SSE streaming helper — supports OpenAI Chat Completions and Anthropic Messages.
 *
 * fetch is required here (not Obsidian's requestUrl) because requestUrl does
 * not expose the ReadableStream needed for SSE.
 *
 * @param url           - API endpoint
 * @param headers       - request headers (Authorization, x-api-key etc.)
 * @param body          - request body (serialized to JSON)
 * @param extractDelta  - function that extracts text from an SSE event
 * @param onChunk       - callback fired after each new fragment (full text so far)
 * @param signal        - AbortSignal to interrupt the stream
 */
export async function streamSSE(
	url:           string,
	headers:       Record<string, string>,
	body:          Record<string, unknown>,
	extractDelta:  DeltaExtractor,
	onChunk:       ((fullText: string) => void) | null,
	signal?:       AbortSignal | null,
): Promise<StreamResult> {
	// NOTE: Using fetch() for SSE streaming as requestUrl() doesn't support streaming.
	// This requires isDesktopOnly: true in manifest.json.
	const response = await fetch(url, {
		method:  "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body:    JSON.stringify(body),
		signal:  signal ?? undefined,
	});

	if (!response.ok) {
		await throwHttpError(response, body.model as string | undefined);
	}

	const reader   = response.body!.getReader();
	const decoder  = new TextDecoder();
	let fullText   = "";
	let buffer     = "";
	let finished   = false;
	let chunksDelivered = false;
	let usage: StreamUsage | null = null;

	const abortError = (): Error => {
		const e = new Error("Aborted by user");
		e.name = "AbortError";
		return e;
	};

	try {
		while (!finished) {
			if (signal?.aborted) throw abortError();
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (signal?.aborted) throw abortError();
				if (!line.startsWith("data: ")) continue;

				const data = line.slice(6).trim();
				if (data === "[DONE]") { finished = true; break; }

				let event: Record<string, unknown>;
				try { event = JSON.parse(data) as Record<string, unknown>; }
				catch { continue; } // incomplete chunk — skip

				// Stream-side error (Anthropic/OpenAI may emit an "error" event)
				if (event.type === "error" || event.error) {
					const err = event.error as { message?: string } | undefined;
					throw new Error(err?.message ?? (event.message as string) ?? t("err_stream"));
				}

				// Collect usage:
				// OpenAI: last chunk before [DONE] (when stream_options.include_usage = true)
				// Anthropic: message_start (input), message_delta (output)
				const eventUsage = event.usage as Record<string, unknown> | undefined;
				if (eventUsage) {
					const details: Record<string, number> | undefined = eventUsage.completion_tokens_details as Record<string, number> | undefined;
					const prevInput:     number = usage !== null ? usage.input     : 0;
					const prevOutput:    number = usage !== null ? usage.output    : 0;
					const prevReasoning: number = usage !== null ? usage.reasoning : 0;
					usage = {
						input:     (eventUsage.prompt_tokens     as number | undefined) ??
						           (eventUsage.input_tokens      as number | undefined) ??
						           prevInput,
						output:    (eventUsage.completion_tokens as number | undefined) ??
						           (eventUsage.output_tokens     as number | undefined) ??
						           prevOutput,
						reasoning: details?.reasoning_tokens ?? prevReasoning,
					};
				}

				// Anthropic: message_start carries input_tokens in a different shape
				if (event.type === "message_start") {
					const msg = event.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
					if (msg?.usage) {
						usage = {
							input:     msg.usage.input_tokens  ?? 0,
							output:    msg.usage.output_tokens ?? 0,
							reasoning: 0,
						};
					}
				}

				// Anthropic: message_delta carries output_tokens
				if (event.type === "message_delta") {
					const deltaUsage = event.usage as { output_tokens?: number } | undefined;
					if (deltaUsage?.output_tokens != null) {
						usage = {
							input:     usage !== null ? usage.input     : 0,
							reasoning: usage !== null ? usage.reasoning : 0,
							output:    deltaUsage.output_tokens,
						};
					}
				}

				const delta = extractDelta(event);
				if (delta) {
					fullText += delta;
					chunksDelivered = true;
					onChunk?.(fullText);
				}
			}
		}
	} catch (err) {
		// Once any chunk has reached the UI, retrying would corrupt the visible
		// output. Flag the error so withRetry stops here.
		if (chunksDelivered && (err as { name?: string }).name !== "AbortError") {
			(err as { noRetry?: boolean }).noRetry = true;
		}
		throw err;
	} finally {
		// Always release the connection on early exit (error or abort)
		if (!finished) {
			try { await reader.cancel(); } catch { /* ignore */ }
		}
	}

	if (!fullText.trim()) throw new Error(t("err_empty_response"));
	return { text: fullText.trim(), usage };
}
