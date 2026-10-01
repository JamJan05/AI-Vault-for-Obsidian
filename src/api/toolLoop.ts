import type { ToolCall, ToolResult, ToolSet } from "../tools/types";

/**
 * Rounds of tool calls answered within one message. Past this the calls are
 * refused and the model is asked to finish, so it cannot loop forever.
 */
export const MAX_TOOL_ROUNDS = 12;

function abortError(): Error {
	const error = new Error("Aborted by user");
	error.name = "AbortError";
	return error;
}

const LIMIT_MESSAGE = "The limit of tool calls for this message has been reached. Do not call more tools. Answer with what you have.";

/**
 * Runs the calls of one reply, one after another, so that confirmation dialogs
 * never overlap.
 * @param refuse answer every call with the limit message instead of running it
 */
export async function runToolCalls(
	tools:  ToolSet,
	calls:  ToolCall[],
	signal: AbortSignal | null,
	refuse: boolean,
): Promise<ToolResult[]> {
	const results: ToolResult[] = [];
	for (const call of calls) {
		if (signal?.aborted) throw abortError();
		const outcome = refuse
			? { content: LIMIT_MESSAGE, isError: true }
			: await tools.run(call);
		results.push({ id: call.id, ...outcome });
	}
	if (signal?.aborted) throw abortError();
	return results;
}

/** Joins the text of successive replies of one exchange. */
export function joinReplyText(text: string, next: string | null): string {
	const addition = next?.trim() ?? "";
	if (!addition) return text;
	return text ? `${text}\n\n${addition}` : addition;
}
