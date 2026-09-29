/**
 * Retention decides which conversations are deleted from disk, so the rule is
 * tested directly: the ones used longest ago go, never an active one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_SESSIONS, sortByRecency, splitForRetention } from "../../src/history/retention";

interface Session { id: string; createdAt: number; updatedAt: number }

const session = (id: string, createdAt: number, updatedAt = createdAt): Session =>
	({ id, createdAt, updatedAt });

describe("sortByRecency", () => {
	it("puts the most recently used conversation first", () => {
		const sorted = sortByRecency([session("old", 1), session("new", 3), session("mid", 2)]);
		assert.deepEqual(sorted.map(s => s.id), ["new", "mid", "old"]);
	});

	it("ranks by last use, not by creation", () => {
		const sorted = sortByRecency([session("created-late", 50), session("created-early-still-used", 1, 99)]);
		assert.deepEqual(sorted.map(s => s.id), ["created-early-still-used", "created-late"]);
	});

	it("keeps the given order for equal timestamps", () => {
		const sorted = sortByRecency([session("a", 5), session("b", 5), session("c", 5)]);
		assert.deepEqual(sorted.map(s => s.id), ["a", "b", "c"]);
	});

	it("does not modify its input", () => {
		const input = [session("old", 1), session("new", 2)];
		sortByRecency(input);
		assert.deepEqual(input.map(s => s.id), ["old", "new"]);
	});

	it("treats a missing or broken timestamp as the oldest", () => {
		const broken = { id: "broken", createdAt: NaN, updatedAt: undefined as unknown as number };
		const sorted = sortByRecency([broken, session("ok", 1)]);
		assert.deepEqual(sorted.map(s => s.id), ["ok", "broken"]);
	});
});

describe("splitForRetention", () => {
	it("evicts nothing while the history fits", () => {
		const { kept, evicted } = splitForRetention([session("a", 1), session("b", 2)], 5);
		assert.equal(kept.length, 2);
		assert.deepEqual(evicted, []);
	});

	it("evicts the conversations used longest ago", () => {
		const { kept, evicted } = splitForRetention(
			[session("a", 1), session("b", 2), session("c", 3), session("d", 4)],
			2,
		);
		assert.deepEqual(kept.map(s => s.id), ["d", "c"]);
		assert.deepEqual(evicted.map(s => s.id), ["b", "a"]);
	});

	it("never evicts a conversation that is still in use, however early it was created", () => {
		const sessions = [session("first-but-active", 0, 10_000)];
		for (let i = 1; i <= MAX_SESSIONS; i++) sessions.push(session(`s${i}`, i));

		const { kept, evicted } = splitForRetention(sessions);
		assert.equal(kept.length, MAX_SESSIONS);
		assert.equal(kept[0].id, "first-but-active");
		assert.deepEqual(evicted.map(s => s.id), ["s1"]);
	});

	it("loses no conversation and duplicates none", () => {
		const sessions = Array.from({ length: 7 }, (_v, i) => session(`s${i}`, i));
		const { kept, evicted } = splitForRetention(sessions, 3);
		const ids = [...kept, ...evicted].map(s => s.id).sort();
		assert.deepEqual(ids, sessions.map(s => s.id).sort());
	});

	it("handles a zero, negative or fractional limit", () => {
		const sessions = [session("a", 1), session("b", 2)];
		assert.equal(splitForRetention(sessions, 0).kept.length, 0);
		assert.equal(splitForRetention(sessions, -3).kept.length, 0);
		assert.equal(splitForRetention(sessions, 1.9).kept.length, 1);
	});
});
