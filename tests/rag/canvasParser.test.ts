import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCanvasToText } from "../../src/rag/canvasParser";

describe("parseCanvasToText — malformed input", () => {
	it("returns a message instead of throwing on invalid JSON", () => {
		const out = parseCanvasToText("{not json", "Board");
		assert.equal(typeof out, "string");
		assert.ok(out.includes("Board"));
	});

	it("handles an empty string", () => {
		assert.doesNotThrow(() => parseCanvasToText("", "Board"));
	});

	it("handles JSON that is not an object", () => {
		for (const raw of ["[]", "42", '"text"', "null"]) {
			assert.doesNotThrow(() => parseCanvasToText(raw, "Board"), `failed for ${raw}`);
		}
	});

	it("reports a canvas with no nodes", () => {
		const out = parseCanvasToText(JSON.stringify({ nodes: [], edges: [] }), "Empty");
		assert.ok(out.includes("Empty"));
	});

	it("ignores nodes and edges that are not arrays", () => {
		const out = parseCanvasToText(JSON.stringify({ nodes: "x", edges: {} }), "Weird");
		assert.ok(out.includes("Weird"));
	});
});

describe("parseCanvasToText — content", () => {
	const canvas = {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, text: "# Start\nfirst step" },
			{ id: "b", type: "text", x: 100, y: 0, text: "second step" },
			{ id: "c", type: "file", x: 200, y: 0, file: "Notes/linked.md" },
			{ id: "d", type: "link", x: 300, y: 0, url: "https://example.com" },
			{ id: "e", type: "group", x: 400, y: 0, label: "Group one" },
		],
		edges: [
			{ id: "e1", fromNode: "a", toNode: "b", label: "then" },
			{ id: "e2", fromNode: "b", toNode: "c" },
		],
	};

	const out = parseCanvasToText(JSON.stringify(canvas), "Flow");

	it("includes the canvas title", () => {
		assert.ok(out.includes("# Canvas: Flow"));
	});

	it("includes text node bodies", () => {
		assert.ok(out.includes("first step"));
		assert.ok(out.includes("second step"));
	});

	it("describes the flow between connected nodes", () => {
		assert.ok(out.includes("→"));
		assert.ok(out.includes("then"));
	});

	it("names file and link nodes", () => {
		assert.ok(out.includes("Notes/linked.md"));
		assert.ok(out.includes("https://example.com"));
	});

	it("includes group labels", () => {
		assert.ok(out.includes("Group one"));
	});
});

describe("parseCanvasToText — graph edge cases", () => {
	it("does not loop forever on a cycle", () => {
		const cyclic = {
			nodes: [
				{ id: "a", type: "text", text: "A" },
				{ id: "b", type: "text", text: "B" },
			],
			edges: [
				{ fromNode: "a", toNode: "b" },
				{ fromNode: "b", toNode: "a" },
			],
		};
		const out = parseCanvasToText(JSON.stringify(cyclic), "Cycle");
		assert.ok(out.includes("A"));
		assert.ok(out.includes("B"));
	});

	it("still emits isolated nodes that no edge reaches", () => {
		const data = {
			nodes: [
				{ id: "a", type: "text", text: "connected" },
				{ id: "b", type: "text", text: "connected too" },
				{ id: "z", type: "text", text: "orphan node" },
			],
			edges: [{ fromNode: "a", toNode: "b" }],
		};
		const out = parseCanvasToText(JSON.stringify(data), "Mixed");
		assert.ok(out.includes("orphan node"));
	});

	it("ignores edges that point at unknown nodes", () => {
		const data = {
			nodes: [{ id: "a", type: "text", text: "only node" }],
			edges: [{ fromNode: "a", toNode: "missing" }],
		};
		assert.doesNotThrow(() => parseCanvasToText(JSON.stringify(data), "Dangling"));
	});

	it("tolerates nodes without a type or text", () => {
		const data = { nodes: [{ id: "a" }, { id: "b", type: "text" }], edges: [] };
		assert.doesNotThrow(() => parseCanvasToText(JSON.stringify(data), "Sparse"));
	});
});
