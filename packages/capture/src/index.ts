import {
	defineStore,
	defineTable,
	field,
	plainText,
	type RowOf,
} from '@epicenter/app';
import { InstantString } from '@epicenter/app/field';
import type { Data, DeclaredData } from '@epicenter/app/store';
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
	const suppressed = new Set<string>();
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
			suppressed.add(smallest);
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
	return { byId, parent, children, suppressed };
}

/** Move the visible subtree, materializing cycle cuts in the affected components. */
export function moveEntry(data: CaptureData, id: string, parentId: string | null): void {
	const forest = entryForest(data.tables.entries.rows);
	if (!forest.byId.has(id)) throw new Error('The entry is no longer available.');
	if (parentId !== null && !forest.byId.has(parentId))
		throw new Error('The destination is no longer available.');
	for (let current = parentId; current !== null; current = forest.parent.get(current) ?? null) {
		if (current === id) throw new Error('An entry cannot move beneath itself or its replies.');
	}
	const rootOf = (start: string): string => {
		let current = start;
		while (forest.parent.get(current) !== null) current = forest.parent.get(current)!;
		return current;
	};
	const roots = new Set([rootOf(id)]);
	if (parentId !== null) roots.add(rootOf(parentId));
	data.transact(() => {
		for (const cut of roots) {
			if (cut !== id && forest.suppressed.has(cut)) data.tables.entries.update(cut, { parentId: null });
		}
		data.tables.entries.update(id, { parentId });
	});
}

/** A snapshot of exactly the readable entries and bodies offered for deletion. */
export function previewDeletion(data: CaptureData, id: string) {
	const table = data.tables.entries;
	const forest = entryForest(table.rows);
	if (!forest.byId.has(id)) throw new Error('The entry is no longer available.');
	const ids: string[] = [];
	const depth = new Map<string, number>();
	const visit = (current: string, level: number) => {
		ids.push(current);
		depth.set(current, level);
		for (const child of forest.children.get(current) ?? []) visit(child.id, level + 1);
	};
	visit(id, 0);
	const selected = new Set(ids);
	for (const row of table.nonconforming) {
		const parent = row.raw.parentId;
		if (parent !== null && (typeof parent !== 'string' || selected.has(parent)))
			throw new Error('Unreadable entries could belong to this subtree.');
	}
	return {
		rootId: id,
		ids,
		entries: ids.map((entryId) => ({
			id: entryId,
			parentId: forest.parent.get(entryId) ?? null,
			depth: depth.get(entryId)!,
			text: table.body(entryId)?.toString() ?? '',
		})),
	};
}

/** Delete only the IDs the person confirmed after checking the current local preview. */
export async function deleteConfirmedSubtree(
	data: CaptureData & Pick<Data<typeof captureDefinition>, 'persistence'>,
	preview: ReturnType<typeof previewDeletion>,
): Promise<void> {
	if (data.tables.entries.get(preview.rootId)) {
		const current = previewDeletion(data, preview.rootId);
		if (JSON.stringify(current) !== JSON.stringify(preview))
			throw new Error('This subtree changed. Review it again before deleting.');
	}
	data.transact(() => {
		for (const id of preview.ids) data.tables.entries.delete(id);
	});
	await data.persistence.flush();
	if (data.persistence.get() !== 'saved')
		throw new Error('Deletion is pending because local storage could not save it.');
}
