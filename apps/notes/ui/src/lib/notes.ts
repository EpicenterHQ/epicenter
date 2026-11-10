/** Labels, ordering, and file-address links shared by the list and editor. */
import type { Note } from './notes.svelte.js';

export const labelOf = (row: Pick<Note, 'title'>) => row.title || 'Untitled';

function instant(at: string | undefined): number {
	const time = at === undefined ? Number.NaN : Date.parse(at);
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first; notes without a valid creation time follow, with paths breaking ties. */
export function order(rows: Note[]): Note[] {
	return rows.toSorted((a, b) => {
		const left = instant(a.createdAt);
		const right = instant(b.createdAt);
		if (left !== right) return left > right ? -1 : 1;
		return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
	});
}

/** The UTC time in a Capture name, when the path has one. */
export function captureTime(path: string): Date | undefined {
	const match =
		/^captures\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-z0-9]{8}\.md$/.exec(
			path,
		);
	if (!match) return;
	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
	const at = new Date(iso);
	if (!Number.isNaN(at.getTime()) && at.toISOString() === iso) return at;
}

export const noteHref = (path: string) =>
	`#/${path.split('/').map(encodeURIComponent).join('/')}`;
export const captureHref = (path: string) => `/capture/${noteHref(path)}`;
export const matches = (row: Pick<Note, 'title'>, query: string) =>
	(row.title ?? '').toLowerCase().includes(query.toLowerCase());
