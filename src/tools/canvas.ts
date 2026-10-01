/**
 * Reading and changing a .canvas file for the note tools.
 *
 * A canvas is JSON (the JSON Canvas format): cards with positions, and the
 * connections between them. A model never edits that JSON as text. It names
 * cards to add, change, remove or connect, and this module applies the request
 * to the parsed file — all of it or none of it — so the result is always a
 * valid canvas and everything it did not ask about stays as it was.
 *
 * Pure, no Obsidian imports, so it is unit tested as written.
 */

export interface CanvasNode extends Record<string, unknown> {
	id:   string;
	type: string;
}

export interface CanvasEdge extends Record<string, unknown> {
	id:       string;
	fromNode: string;
	toNode:   string;
}

export interface CanvasData extends Record<string, unknown> {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

export type CanvasParseResult =
	| { ok: true;  data: CanvasData }
	| { ok: false; reason: string };

export interface CanvasChanges {
	/** New text cards. `id` is a name chosen by the model, usable in `addConnections`. */
	addCards:       Array<{ id: string; text: string }>;
	updateCards:    Array<{ id: string; text: string }>;
	removeCards:    string[];
	addConnections: Array<{ from: string; to: string; label: string }>;
}

export type CanvasApplyResult =
	| { ok: true;  data: CanvasData }
	| { ok: false; reason: string };

/** Limits on one request. */
export const CANVAS_MAX_ITEMS      = 60;
export const CANVAS_MAX_CARD_CHARS = 20_000;

const CARD_WIDTH  = 320;
const CARD_GAP    = 60;
const CARDS_PER_ROW = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Parses a canvas file. An empty file is an empty canvas. */
export function parseCanvas(raw: string): CanvasParseResult {
	if (!raw.trim()) return { ok: true, data: { nodes: [], edges: [] } };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "The file is not valid JSON." };
	}
	if (!isRecord(parsed)) return { ok: false, reason: "The file is not a canvas." };

	const nodes = parsed.nodes ?? [];
	const edges = parsed.edges ?? [];
	if (!Array.isArray(nodes) || !Array.isArray(edges)) return { ok: false, reason: "The file is not a canvas." };

	for (const node of nodes) {
		if (!isRecord(node) || typeof node.id !== "string" || !node.id || typeof node.type !== "string") {
			return { ok: false, reason: "The canvas contains a card without an id or a type." };
		}
	}
	for (const edge of edges) {
		if (!isRecord(edge) || typeof edge.id !== "string"
			|| typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") {
			return { ok: false, reason: "The canvas contains a malformed connection." };
		}
	}

	return { ok: true, data: { ...parsed, nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[] } };
}

/** Obsidian writes canvases indented with tabs. */
export function serializeCanvas(data: CanvasData): string {
	return JSON.stringify(data, null, "\t");
}

function indent(text: string): string {
	return text.replace(/\r\n?/g, "\n").split("\n").map(line => `    ${line}`).join("\n");
}

/**
 * A value that must stay on its own line. The description is what the user
 * approves, so a line break inside an id, a label or a file name must not be
 * able to start what looks like another card or connection.
 */
function oneLine(value: unknown): string {
	return typeof value === "string" ? value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n") : "";
}

/** Free text chosen by a model or found in a file, quoted so that it cannot pass for structure. */
function quoted(value: unknown): string {
	return JSON.stringify(typeof value === "string" ? value : "");
}

function describeNode(node: CanvasNode): string {
	const head = `- [${oneLine(node.id)}]`;
	if (node.type === "text") {
		const text = typeof node.text === "string" ? node.text : "";
		return text ? `${head} text card:\n${indent(text)}` : `${head} text card: (empty)`;
	}
	if (node.type === "file") {
		const subpath = typeof node.subpath === "string" && node.subpath ? oneLine(node.subpath) : "";
		return `${head} file card: ${oneLine(node.file)}${subpath}`;
	}
	if (node.type === "link") return `${head} link card: ${oneLine(node.url)}`;
	if (node.type === "group") {
		const background = typeof node.background === "string" && node.background
			? `, background image: ${oneLine(node.background)}`
			: "";
		return `${head} group: ${quoted(node.label)}${background}`;
	}
	return `${head} ${oneLine(node.type)} card`;
}

/**
 * The canvas as text: every card with its id and content, then every connection.
 * Shown to the model, and — before and after a change — to the user.
 */
export function describeCanvas(data: CanvasData): string {
	if (!data.nodes.length) return "(The canvas is empty.)";

	const lines = ["Cards:", ...data.nodes.map(describeNode)];
	if (data.edges.length) {
		lines.push("", "Connections:");
		for (const edge of data.edges) {
			const label = typeof edge.label === "string" && edge.label ? `: ${quoted(edge.label)}` : "";
			lines.push(`- ${oneLine(edge.fromNode)} -> ${oneLine(edge.toNode)}${label}`);
		}
	}
	return lines.join("\n");
}

function cardHeight(text: string): number {
	const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 38)), 0);
	return Math.min(480, Math.max(80, 40 + lines * 26));
}

/** Sides that make a connection leave and enter on the edges that face each other. */
function sidesFor(from: CanvasNode, to: CanvasNode): { fromSide: string; toSide: string } {
	const dx = (num(to.x) + num(to.width) / 2) - (num(from.x) + num(from.width) / 2);
	const dy = (num(to.y) + num(to.height) / 2) - (num(from.y) + num(from.height) / 2);
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
	}
	return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

/**
 * Applies the changes to a copy of the canvas. Any mistake — an unknown card, a
 * card that is not a text card, a repeated name — refuses the whole request.
 * @param newId returns a fresh id; it is called once per new card and connection
 */
export function applyCanvasChanges(data: CanvasData, changes: CanvasChanges, newId: () => string): CanvasApplyResult {
	const refuse = (reason: string): CanvasApplyResult => ({ ok: false, reason });

	const total = changes.addCards.length + changes.updateCards.length
		+ changes.removeCards.length + changes.addConnections.length;
	if (!total) return refuse("No change was requested.");
	if (total > CANVAS_MAX_ITEMS) return refuse(`Too many changes in one call. The limit is ${CANVAS_MAX_ITEMS}.`);

	const nodes = data.nodes.map(node => ({ ...node }));
	let   edges = data.edges.map(edge => ({ ...edge }));
	const byId  = new Map(nodes.map(node => [node.id, node]));
	const used  = new Set([...nodes.map(node => node.id), ...edges.map(edge => edge.id)]);

	const freshId = (): string => {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = newId();
			if (id && !used.has(id)) { used.add(id); return id; }
		}
		throw new Error("Could not make a unique id.");
	};

	// Changes to existing cards first, so a card can be removed and its name reused.
	for (const update of changes.updateCards) {
		const node = byId.get(update.id);
		if (!node) return refuse(`There is no card with id ${update.id}. Read the canvas for the ids.`);
		if (node.type !== "text") return refuse(`Card ${update.id} is a ${node.type} card. Only text cards can be changed.`);
		if (update.text.length > CANVAS_MAX_CARD_CHARS) return refuse("The text of a card is too long.");
		node.text = update.text;
	}

	const removed = new Set<string>();
	for (const id of changes.removeCards) {
		if (!byId.has(id)) return refuse(`There is no card with id ${id}. Read the canvas for the ids.`);
		removed.add(id);
	}
	if (changes.updateCards.some(update => removed.has(update.id))) {
		return refuse("A card is both changed and removed.");
	}
	const kept = nodes.filter(node => !removed.has(node.id));
	edges = edges.filter(edge => !removed.has(edge.fromNode) && !removed.has(edge.toNode));

	// New cards go in rows under everything that is already there.
	const left   = kept.length ? Math.min(...kept.map(node => num(node.x))) : 0;
	const bottom = kept.length ? Math.max(...kept.map(node => num(node.y) + num(node.height))) + 100 : 0;

	const named = new Map<string, CanvasNode>();
	let rowTop    = bottom;
	let rowHeight = 0;
	changes.addCards.forEach((card, index) => {
		if (index > 0 && index % CARDS_PER_ROW === 0) { rowTop += rowHeight + CARD_GAP; rowHeight = 0; }
		const height = cardHeight(card.text);
		rowHeight = Math.max(rowHeight, height);
		named.set(card.id, {
			id:     "",
			type:   "text",
			text:   card.text,
			x:      left + (index % CARDS_PER_ROW) * (CARD_WIDTH + CARD_GAP),
			y:      rowTop,
			width:  CARD_WIDTH,
			height,
		});
	});
	if (named.size !== changes.addCards.length) return refuse("Two new cards have the same id.");
	for (const card of changes.addCards) {
		if (!card.id) return refuse("A new card has no id.");
		if (byId.has(card.id) && !removed.has(card.id)) return refuse(`A card with id ${card.id} already exists. Choose another id for the new card.`);
		if (card.text.length > CANVAS_MAX_CARD_CHARS) return refuse("The text of a card is too long.");
	}
	for (const node of named.values()) node.id = freshId();

	const find = (id: string): CanvasNode | undefined =>
		named.get(id) ?? (removed.has(id) ? undefined : byId.get(id));

	const added: CanvasEdge[] = [];
	for (const connection of changes.addConnections) {
		const from = find(connection.from);
		const to   = find(connection.to);
		if (!from) return refuse(`There is no card with id ${connection.from} to connect from.`);
		if (!to)   return refuse(`There is no card with id ${connection.to} to connect to.`);
		if (from === to) return refuse("A card cannot be connected to itself.");

		const edge: CanvasEdge = { id: freshId(), fromNode: from.id, ...sidesFor(from, to), toNode: to.id };
		if (connection.label) edge.label = connection.label.slice(0, 500);
		added.push(edge);
	}

	return { ok: true, data: { ...data, nodes: [...kept, ...named.values()], edges: [...edges, ...added] } };
}

/** A 16-character hexadecimal id, like the ones Obsidian gives to cards. */
export function randomCanvasId(): string {
	let id = "";
	for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
	return id;
}
