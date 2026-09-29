/**
 * Which conversations are kept when the history is full.
 * Dependency-free, because the losing side of this decision is deleted from disk.
 */

export const MAX_SESSIONS = 100;

interface Dated {
	updatedAt: number;
	createdAt: number;
}

function lastActivity(session: Dated): number {
	const updated = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
	const created = Number.isFinite(session.createdAt) ? session.createdAt : 0;
	return Math.max(updated, created);
}

/** Most recently used first. Stable, and does not modify the input. */
export function sortByRecency<T extends Dated>(sessions: readonly T[]): T[] {
	return sessions
		.map((session, position) => ({ session, position }))
		.sort((a, b) => lastActivity(b.session) - lastActivity(a.session) || a.position - b.position)
		.map(item => item.session);
}

/**
 * Splits the history into what stays and what is evicted. The conversations used
 * longest ago go first — never one that was merely created early and is still in use.
 */
export function splitForRetention<T extends Dated>(
	sessions: readonly T[],
	max = MAX_SESSIONS,
): { kept: T[]; evicted: T[] } {
	const sorted = sortByRecency(sessions);
	const limit  = Math.max(0, Math.floor(max));
	return { kept: sorted.slice(0, limit), evicted: sorted.slice(limit) };
}
