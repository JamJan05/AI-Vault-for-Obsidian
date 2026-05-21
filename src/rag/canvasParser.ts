import { t } from "../i18n";

// ─── Typy Obsidian Canvas ──────────────────────────────────────────────────────

interface CanvasNode {
	id:     string;
	type:   "text" | "file" | "link" | "group";
	x?:     number;
	y?:     number;
	text?:  string;
	file?:  string;
	url?:   string;
	label?: string;
}

interface CanvasEdge {
	id?:      string;
	fromNode: string;
	toNode:   string;
	label?:   string;
}

interface CanvasData {
	nodes?: CanvasNode[];
	edges?: CanvasEdge[];
}

/**
 * Converts a .canvas file (JSON) into readable text for RAG.
 *
 * Obsidian Canvas = JSON with nodes[] and edges[].
 * Node types: text, file, link, group.
 * The parser reconstructs the step order via edges (topological BFS)
 * and builds a readable document with the flow and node contents.
 */
export function parseCanvasToText(raw: string, basename: string): string {
	let data: CanvasData;
	try {
		data = JSON.parse(raw) as CanvasData;
	} catch {
		return t("canvas_parse_error", basename);
	}

	const nodes: CanvasNode[] = Array.isArray(data.nodes) ? data.nodes : [];
	const edges: CanvasEdge[] = Array.isArray(data.edges) ? data.edges : [];

	if (!nodes.length) return t("canvas_no_nodes", basename);

	// Map id → node
	const nodeMap = new Map<string, CanvasNode>(nodes.map(n => [n.id, n]));

	// Build the graph: successors and predecessors
	const successors   = new Map<string, Set<string>>();
	const predecessors = new Map<string, Set<string>>();
	for (const n of nodes) {
		successors.set(n.id, new Set());
		predecessors.set(n.id, new Set());
	}
	for (const e of edges) {
		if (e.fromNode && e.toNode) {
			successors.get(e.fromNode)?.add(e.toNode);
			predecessors.get(e.toNode)?.add(e.fromNode);
		}
	}

	// Starting nodes (no predecessors) — sort by X position (left→right)
	const starts = nodes
		.filter(n => (predecessors.get(n.id)?.size ?? 0) === 0)
		.sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0));

	// BFS / topological graph traversal
	const visited = new Set<string>();
	const ordered: CanvasNode[] = [];

	const traverse = (id: string): void => {
		if (visited.has(id)) return;
		visited.add(id);

		const node = nodeMap.get(id);
		if (node) ordered.push(node);

		// Sort successors by Y (top→bottom) then X
		const nexts = [...(successors.get(id) ?? [])]
			.map(sid => nodeMap.get(sid))
			.filter((n): n is CanvasNode => n !== undefined)
			.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

		for (const next of nexts) traverse(next.id);
	};

	for (const s of starts) traverse(s.id);

	// Append isolated nodes (no edges), sorted by X
	nodes
		.filter(n => !visited.has(n.id))
		.sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
		.forEach(n => ordered.push(n));

	// Build the text
	const lines: string[] = [`# Canvas: ${basename}\n`];

	// Flow section (only when there are edges)
	if (edges.length) {
		const flowParts: string[] = [];
		for (const e of edges) {
			const from = nodeMap.get(e.fromNode);
			const to   = nodeMap.get(e.toNode);
			if (!from || !to) continue;

			const edgeLabel = e.label ? ` —[${e.label}]→ ` : " → ";
			flowParts.push(`${nodeLabel(from)}${edgeLabel}${nodeLabel(to)}`);
		}
		if (flowParts.length) {
			lines.push(t("canvas_flow_header"));
			lines.push(flowParts.join("\n") + "\n");
		}
	}

	// Section with node contents
	lines.push(t("canvas_content_header"));
	for (const n of ordered) {
		switch (n.type) {
			case "text":
				if (n.text?.trim()) {
					lines.push(`### ${nodeLabel(n)}`);
					lines.push(n.text.trim() + "\n");
				}
				break;
			case "file":
				lines.push(`### Plik: ${n.file || nodeLabel(n)}\n`);
				break;
			case "link":
				lines.push(`### Link: ${n.url || nodeLabel(n)}\n`);
				break;
			case "group":
				if (n.label?.trim()) {
					lines.push(`## Grupa: ${n.label.trim()}\n`);
				}
				break;
		}
	}

	return lines.join("\n");
}

/** Returns a short node label (used in the flow description) */
function nodeLabel(n: CanvasNode): string {
	if (n.label) return n.label;
	if (n.type === "text" && n.text) {
		const header = n.text.match(/^#+\s*(.+)/m);
		return header
			? header[1].trim()
			: n.text.slice(0, 40).replace(/\n/g, " ").trim();
	}
	if (n.type === "file") return n.file?.split("/").pop() ?? n.id;
	if (n.type === "link") return n.url ?? n.id;
	return n.id;
}
