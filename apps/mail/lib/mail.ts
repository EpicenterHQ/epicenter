/** Open action-scoped SQLite resources and resolve label assertions. */
import { folder } from '@epicenter/app';
import { systemLabels } from './fixture.js';
import { openFixtureGmail } from './gmail.js';
import { openStore, type Store } from './store.js';

export function appDirectory() {
	const dir = folder.path;
	if (dir === undefined)
		throw new Error(
			'Mail keeps its mailbox in SQLite files, so it runs only on a computer',
		);
	return dir;
}
export async function withStore<T>(run: (store: Store) => T | Promise<T>) {
	const store = openStore(appDirectory());
	try {
		return await run(store);
	} finally {
		store.close();
	}
}
export async function withGmail<T>(
	run: (
		store: Store,
		gmail: ReturnType<typeof openFixtureGmail>,
	) => T | Promise<T>,
) {
	return withStore(async (store) => {
		const gmail = openFixtureGmail(appDirectory());
		try {
			return await run(store, gmail);
		} finally {
			gmail.close();
		}
	});
}
export function assertLabels(
	store: Store,
	{ ids, add, remove }: { ids: string[]; add: string[]; remove: string[] },
) {
	if (!ids.length) throw new Error('Give at least one message id');
	if (!add.length && !remove.length)
		throw new Error('Give a label to add or remove');
	const labels = store.listLabels();
	function resolve(value: string) {
		const system = systemLabels.find(
			(l) => l.id.toLowerCase() === value.toLowerCase(),
		);
		const label =
			system ??
			labels.find(
				(l) =>
					l.id.toLowerCase() === value.toLowerCase() ||
					l.name.toLowerCase() === value.toLowerCase(),
			);
		if (!label)
			throw new Error(`No label named "${value}"; mail labels lists them`);
		return label;
	}
	const added = [...new Map(add.map(resolve).map((l) => [l.id, l])).values()];
	const removed = [
		...new Map(remove.map(resolve).map((l) => [l.id, l])).values(),
	];
	if (added.some((l) => removed.some((r) => r.id === l.id)))
		throw new Error('A label cannot be both added and removed');
	const pairs = [...new Set(ids)].flatMap((id) => [
		...added.map((l) => ({ id, label: l.id, want: true })),
		...removed.map((l) => ({ id, label: l.id, want: false })),
	]);
	const names = new Map([...added, ...removed].map((l) => [l.id, l.name]));
	return {
		asserted: store.assert(pairs).map((i) => ({
			id: i.message_id,
			label: i.label_id,
			name: names.get(i.label_id)!,
			want: i.want === 1,
			seq: i.seq,
		})),
		pending: store.pendingSummary().count,
	};
}
