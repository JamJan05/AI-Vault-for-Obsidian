/**
 * Changing a canvas means rewriting a JSON file the user drew by hand. These
 * tests check that a request is applied whole or not at all, and that nothing
 * the request did not name is lost.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CANVAS_MAX_ITEMS,
	applyCanvasChanges,
	describeCanvas,
	parseCanvas,
	randomCanvasId,
	serializeCanvas,
} from "../../src/tools/canvas";
import type { CanvasChanges, CanvasData } from "../../src/tools/canvas";

const BASE: CanvasData = {
	nodes: [
		{ id: "a", type: "text", text: "Alpha", x: 0, y: 0, width: 250, height: 60, color: "1" },
		{ id: "b", type: "text", text: "Beta", x: 400, y: 0, width: 250, height: 60 },
		{ id: "g", type: "group", label: "Group", x: -20, y: -20, width: 700, height: 120 },
		{ id: "f", type: "file", file: "Notes/Plan.md", x: 0, y: 200, width: 250, height: 300 },
	],
	edges: [{ id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", color: "2" }],
	futureField: { kept: true },
};

const NONE: CanvasChanges = { addCards: [], updateCards: [], removeCards: [], addConnections: [] };
const ids = (): (() => string) => { let n = 0; return () => `new${++n}`; };

function apply(changes: Partial<CanvasChanges>, data: CanvasData = BASE): CanvasData {
	const result = applyCanvasChanges(data, { ...NONE, ...changes }, ids());
	if (!result.ok) throw new Error(result.reason);
	return result.data;
}

function refused(changes: Partial<CanvasChanges>, data: CanvasData = BASE): string {
	const result = applyCanvasChanges(data, { ...NONE, ...changes }, ids());
	assert.equal(result.ok, false);
	return result.ok ? "" : result.reason;
}

describe("parseCanvas", () => {
	it("round-trips a canvas, unknown fields included", () => {
		const parsed = parseCanvas(serializeCanvas(BASE));
		assert.deepEqual(parsed, { ok: true, data: BASE });
	});

	it("treats an empty file as an empty canvas, and missing lists as empty", () => {
		assert.deepEqual(parseCanvas(""), { ok: true, data: { nodes: [], edges: [] } });
		assert.deepEqual(parseCanvas("  \n"), { ok: true, data: { nodes: [], edges: [] } });
		assert.deepEqual(parseCanvas("{}"), { ok: true, data: { nodes: [], edges: [] } });
	});

	it("refuses anything that is not a canvas", () => {
		for (const raw of [
			"{not json", "null", "[]", "42", "\"text\"",
			"{\"nodes\":5}", "{\"nodes\":[],\"edges\":{}}",
			"{\"nodes\":[null]}", "{\"nodes\":[{\"type\":\"text\"}]}", "{\"nodes\":[{\"id\":\"\",\"type\":\"text\"}]}",
			"{\"nodes\":[{\"id\":\"a\"}]}", "{\"edges\":[{\"id\":\"e\",\"fromNode\":\"a\"}]}",
		]) {
			assert.equal(parseCanvas(raw).ok, false, raw);
		}
	});

	it("writes tabs, like Obsidian", () => {
		assert.match(serializeCanvas({ nodes: [], edges: [] }), /^\{\n\t"nodes"/);
	});
});

describe("describeCanvas", () => {
	it("lists every card with its id and content, then the connections", () => {
		const text = describeCanvas({ ...BASE, edges: [{ id: "e1", fromNode: "a", toNode: "b", label: "then" }] });
		assert.equal(text, [
			"Cards:",
			"- [a] text card:",
			"    Alpha",
			"- [b] text card:",
			"    Beta",
			"- [g] group: \"Group\"",
			"- [f] file card: Notes/Plan.md",
			"",
			"Connections:",
			"- a -> b: \"then\"",
		].join("\n"));
	});

	it("keeps multi-line text inside its card", () => {
		const text = describeCanvas({ nodes: [{ id: "a", type: "text", text: "one\n- [x] fake card" }], edges: [] });
		assert.match(text, /- \[a\] text card:\n {4}one\n {4}- \[x\] fake card/);
	});

	it("does not let a label, an id or a file name forge another line", () => {
		const forged = describeCanvas({
			nodes: [
				{ id: "a", type: "text", text: "A" },
				{ id: "b\n- [x] text card: fake", type: "file", file: "Plan.md\n- [y] text card: fake" },
				{ id: "g", type: "group", label: "G\n- [z] text card: fake" },
			],
			edges: [{ id: "e", fromNode: "a", toNode: "g", label: "ok\"\n- g -> a: \"next" }],
		});
		const lines = forged.split("\n");
		assert.equal(lines.filter(line => line.startsWith("- [")).length, 3, "three cards, no more");
		assert.equal(lines.filter(line => line.includes(" -> ")).length, 1, "one connection, no more");

		const honest = describeCanvas({
			nodes: [{ id: "a", type: "text", text: "A" }, { id: "g", type: "group", label: "G" }],
			edges: [{ id: "e", fromNode: "a", toNode: "g", label: "ok" }, { id: "f", fromNode: "g", toNode: "a", label: "next" }],
		});
		assert.notEqual(forged.split("Connections:")[1], honest.split("Connections:")[1]);
	});

	it("shows what a file card points at and what a group shows", () => {
		const text = describeCanvas({
			nodes: [
				{ id: "f", type: "file", file: "Plan.md", subpath: "#Goals" },
				{ id: "g", type: "group", label: "Area", background: "img/map.png" },
			],
			edges: [],
		});
		assert.match(text, /\[f\] file card: Plan\.md#Goals/);
		assert.match(text, /\[g\] group: "Area", background image: img\/map\.png/);
	});

	it("says when the canvas is empty, and survives odd cards", () => {
		assert.equal(describeCanvas({ nodes: [], edges: [] }), "(The canvas is empty.)");
		const text = describeCanvas({ nodes: [{ id: "a", type: "text" }, { id: "z", type: "future" }], edges: [] });
		assert.match(text, /\[a\] text card: \(empty\)/);
		assert.match(text, /\[z\] future card/);
	});
});

describe("applyCanvasChanges", () => {
	it("does not modify the canvas it was given", () => {
		const before = JSON.stringify(BASE);
		apply({ updateCards: [{ id: "a", text: "changed" }], removeCards: ["b"], addCards: [{ id: "n", text: "new" }] });
		assert.equal(JSON.stringify(BASE), before);
	});

	it("changes only the text of the named card", () => {
		const data = apply({ updateCards: [{ id: "a", text: "Alpha 2" }] });
		assert.deepEqual(data.nodes[0], { ...BASE.nodes[0], text: "Alpha 2" });
		assert.deepEqual(data.nodes.slice(1), BASE.nodes.slice(1));
		assert.deepEqual(data.edges, BASE.edges);
		assert.deepEqual(data.futureField, { kept: true });
	});

	it("adds a card below everything else, with a fresh id and a size", () => {
		const data = apply({ addCards: [{ id: "mine", text: "New card" }] });
		const card = data.nodes[data.nodes.length - 1];
		assert.equal(card.id, "new1");
		assert.equal(card.type, "text");
		assert.equal(card.text, "New card");
		assert.equal(card.x, -20);
		assert.ok((card.y as number) >= 500, "below the lowest card");
		assert.equal(card.width, 320);
		assert.ok((card.height as number) >= 80);
		assert.equal(data.nodes.length, BASE.nodes.length + 1);
	});

	it("lays new cards out without overlap", () => {
		const data  = apply({ addCards: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, text: `card ${i}\nline` })) });
		const added = data.nodes.slice(BASE.nodes.length) as unknown as Array<{ x: number; y: number; width: number; height: number }>;
		for (let i = 0; i < added.length; i++) {
			for (let j = i + 1; j < added.length; j++) {
				const a = added[i];
				const b = added[j];
				const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
				assert.ok(apart, `cards ${i} and ${j} overlap`);
			}
		}
	});

	it("connects existing and new cards, by the name given to a new card", () => {
		const data = apply({
			addCards:       [{ id: "mine", text: "New" }],
			addConnections: [{ from: "a", to: "mine", label: "next" }, { from: "mine", to: "b", label: "" }],
		});
		const card  = data.nodes[data.nodes.length - 1];
		const added = data.edges.slice(1);
		assert.equal(added[0].fromNode, "a");
		assert.equal(added[0].toNode, card.id);
		assert.equal(added[0].label, "next");
		assert.equal(added[1].fromNode, card.id);
		assert.equal(added[1].toNode, "b");
		assert.equal("label" in added[1], false);
		for (const edge of added) {
			assert.ok(["top", "right", "bottom", "left"].includes(edge.fromSide as string));
			assert.ok(["top", "right", "bottom", "left"].includes(edge.toSide as string));
		}
		assert.equal(new Set([...data.nodes, ...data.edges].map(item => item.id)).size, data.nodes.length + data.edges.length);
	});

	it("removes a card with every connection that touches it", () => {
		const data = apply({ removeCards: ["b"] });
		assert.deepEqual(data.nodes.map(node => node.id), ["a", "g", "f"]);
		assert.deepEqual(data.edges, []);
	});

	it("never reuses an id that is already taken", () => {
		const taken = ["a", "e1", "fresh"];
		const result = applyCanvasChanges(BASE, { ...NONE, addCards: [{ id: "n", text: "x" }] }, () => taken.shift() ?? "never");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.data.nodes[result.data.nodes.length - 1].id, "fresh");
	});

	it("refuses the whole request when any part of it is wrong", () => {
		assert.match(refused({}), /No change/);
		assert.match(refused({ updateCards: [{ id: "zzz", text: "x" }] }), /no card with id zzz/);
		assert.match(refused({ updateCards: [{ id: "f", text: "x" }] }), /Only text cards/);
		assert.match(refused({ updateCards: [{ id: "g", text: "x" }] }), /Only text cards/);
		assert.match(refused({ removeCards: ["zzz"] }), /no card with id zzz/);
		assert.match(refused({ updateCards: [{ id: "a", text: "x" }], removeCards: ["a"] }), /both changed and removed/);
		assert.match(refused({ addCards: [{ id: "n", text: "1" }, { id: "n", text: "2" }] }), /same id/);
		assert.match(refused({ addCards: [{ id: "a", text: "x" }] }), /already exists/);
		assert.match(refused({ addCards: [{ id: "", text: "x" }] }), /no id/);
		assert.match(refused({ addConnections: [{ from: "a", to: "zzz", label: "" }] }), /no card with id zzz/);
		assert.match(refused({ addConnections: [{ from: "a", to: "a", label: "" }] }), /itself/);
		assert.match(refused({ removeCards: ["b"], addConnections: [{ from: "a", to: "b", label: "" }] }), /no card with id b/);
		assert.match(refused({ addCards: [{ id: "n", text: "x".repeat(20_001) }] }), /too long/);
		assert.match(
			refused({ addCards: Array.from({ length: CANVAS_MAX_ITEMS + 1 }, (_, i) => ({ id: `n${i}`, text: "x" })) }),
			/Too many/,
		);
	});

	it("starts an empty canvas at the origin", () => {
		const data = apply({ addCards: [{ id: "n", text: "first" }] }, { nodes: [], edges: [] });
		assert.equal(data.nodes[0].x, 0);
		assert.equal(data.nodes[0].y, 0);
	});
});

describe("randomCanvasId", () => {
	it("is 16 hexadecimal characters", () => {
		for (let i = 0; i < 20; i++) assert.match(randomCanvasId(), /^[0-9a-f]{16}$/);
	});
});
