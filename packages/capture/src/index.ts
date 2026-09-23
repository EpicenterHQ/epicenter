import {
	defineStore,
	defineTable,
	field,
	plainText,
	type RowOf,
} from '@epicenter/app';
import { InstantString } from '@epicenter/app/field';
import type { DeclaredData } from '@epicenter/app/store';
import * as Y from '@y/y';

const entries = defineTable({
	fields: {
		parentId: field.nullable(field.string()),
		capturedAt: field.instant(),
	},
	body: plainText(),
});

/** A declaration only. Importing it never opens storage. */
export const captureDefinition = defineStore({
	id: 'so.epicenter.capture',
	title: 'Capture',
	kv: {},
	tables: { entries },
});

export type CaptureData = DeclaredData<typeof captureDefinition>;
export type CaptureEntry = RowOf<typeof entries>;

/** Mint one entry and integrate its initial text in the same store transaction. */
export function createEntry(
	data: CaptureData,
	{
		parentId,
		text,
		capturedAt = InstantString.now(),
	}: {
		parentId: string | null;
		text: string;
		capturedAt?: InstantString;
	},
): CaptureEntry {
	if (parentId !== null && !data.tables.entries.get(parentId))
		throw new Error('The parent entry is no longer available.');
	const body = new Y.Node();
	if (text !== '') body.applyDelta(body.change.insert(text) as never);
	return data.tables.entries.create({ parentId, capturedAt }, body);
}

/** Resolve links in memory so every readable entry has one visible place. */
export function entryForest(rows: readonly CaptureEntry[]) {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const parent = new Map<string, string | null>();
	for (const row of rows) {
		parent.set(
			row.id,
			row.parentId !== row.id && byId.has(row.parentId ?? '')
				? row.parentId
				: null,
		);
	}

	const visited = new Set<string>();
	for (const row of rows) {
		if (visited.has(row.id)) continue;
		const path: string[] = [];
		const position = new Map<string, number>();
		let id: string | null = row.id;
		while (id !== null && !visited.has(id) && !position.has(id)) {
			position.set(id, path.length);
			path.push(id);
			id = parent.get(id) ?? null;
		}
		const cycleStart = id === null ? undefined : position.get(id);
		if (cycleStart !== undefined) {
			const cycle = path.slice(cycleStart);
			const smallest = cycle.reduce((a, b) => (a < b ? a : b));
			parent.set(smallest, null);
		}
		for (const seen of path) visited.add(seen);
	}

	const children = new Map<string | null, CaptureEntry[]>();
	for (const row of rows) {
		const key = parent.get(row.id) ?? null;
		const group = children.get(key) ?? [];
		group.push(row);
		children.set(key, group);
	}
	for (const group of children.values())
		group.sort((a, b) =>
			a.capturedAt === b.capturedAt
				? a.id < b.id
					? -1
					: a.id > b.id
						? 1
						: 0
				: a.capturedAt > b.capturedAt
					? -1
					: 1,
		);
	return { byId, parent, children };
}
