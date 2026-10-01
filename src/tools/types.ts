/**
 * Shapes shared by the note tools and the provider request code.
 *
 * A tool is a function the model may ask the plugin to run. The plugin decides
 * whether to run it; nothing here executes anything.
 */

export interface ToolParameter {
	type:        "string";
	description: string;
}

export interface ToolDefinition {
	name:        string;
	description: string;
	/** JSON Schema of the arguments. Every property is required. */
	parameters: {
		type:                 "object";
		properties:           Record<string, ToolParameter>;
		required:             string[];
		additionalProperties: false;
	};
}

/** A call the model asked for. `input` comes from the provider and is untrusted. */
export interface ToolCall {
	id:    string;
	name:  string;
	input: unknown;
}

export interface ToolOutcome {
	content: string;
	isError: boolean;
}

export interface ToolResult extends ToolOutcome {
	/** Id of the call this answers. */
	id: string;
}

export interface ToolSet {
	readonly definitions: readonly ToolDefinition[];
	/** Never throws: a failure is reported to the model as an error outcome. */
	run(call: ToolCall): Promise<ToolOutcome>;
}
