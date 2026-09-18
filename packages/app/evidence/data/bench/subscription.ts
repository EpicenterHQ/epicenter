/**
 * What a per-table subscription costs per commit, and what it scales with.
 *
 * Run: `bun run evidence/bench/subscription.ts`
 *
 * The question the store's `subscribe` had to answer before it was written.
 * ADR-0187 chose row ids over a void signal because "simplicity here is paid
 * for on every commit, forever", which is only the right trade if the ids are
 * close to free. A `'delta'` listener is not free: attaching one is what makes
 * a `YType` build and emit its delta, so the cost lands on every write whether
 * or not the change is small.
 *
 * What matters is the SHAPE of the cost, not its absolute size. If it scales
 * with the table it is a tax on having data; if it scales with the change it is
 * a tax on making one, and only the second is affordable on a large vault.
 *
 * METHOD:
 *   - One process, but every case runs against a freshly built document, so a
 *     case never inherits the previous one's structs or its warmed caches.
 *   - The corpus build is outside the timed region. Only the commits are timed.
 *   - Every case is paired with a NO-SUBSCRIBER control on the same corpus and
 *     the same commits, so the reported cost is the difference rather than the
 *     machine.
 *   - A LIVENESS control: the subscribed run asserts it actually collected the
 *     row ids it should have. A run where the listener silently stopped firing
 *     would otherwise report the cheapest possible number and read as a win.
 */
import * as Y from '@y/y';

const NOTE = {
	title: 'Recording 2026-08-07 14:32',
	preview:
		'a hundred characters of list subtitle, which is what preview is for',
	pinned: false,
	createdAt: '2026-08-07T14:32:11.000Z',
	updatedAt: '2026-08-07T14:32:11.000Z',
};

function buildTable(rows: number): {
	document: Y.Doc;
	notes: Y.Type;
	ids: string[];
} {
	const document = new Y.Doc({ gc: true });
	const notes = document.get('notes');
	const ids: string[] = [];
	document.transact(() => {
		for (let index = 0; index < rows; index += 1) {
			const rowId = `note-${index.toString().padStart(6, '0')}`;
			ids.push(rowId);
			const row = new Y.Type();
			notes.setAttr(rowId as never, row as never);
			row.setAttr('!doc' as never, new Y.Type() as never);
			for (const [name, value] of Object.entries(NOTE)) {
				row.setAttr(name as never, value as never);
			}
		}
	});
	return { document, notes, ids };
}

/**
 * Edit `edited` rows, `commits` times, and report the median commit in ms.
 *
 * Median rather than mean: the first commit after a build pays for lazily
 * materialised state on both arms, and reporting a mean would let that one
 * outlier decide the comparison.
 */
function timeCommits({
	rows,
	edited,
	commits,
	subscribe,
}: {
	rows: number;
	edited: number;
	commits: number;
	subscribe: boolean;
}): { medianMs: number; collected: number } {
	const { document, notes, ids } = buildTable(rows);
	let collected = 0;
	const listener = (delta: unknown) => {
		const { attrs } = delta as { attrs?: Record<string, unknown> };
		collected += Object.keys(attrs ?? {}).length;
	};
	if (subscribe) notes.on('delta', listener);

	const samples: number[] = [];
	for (let round = 0; round < commits; round += 1) {
		const started = performance.now();
		document.transact(() => {
			for (let index = 0; index < edited; index += 1) {
				const row = notes.getAttr(ids[index] as never) as Y.Type;
				row.setAttr('updatedAt' as never, `edit-${round}-${index}` as never);
			}
		});
		samples.push(performance.now() - started);
	}
	samples.sort((left, right) => left - right);
	return { medianMs: samples[Math.floor(samples.length / 2)] ?? 0, collected };
}

const CASES = [
	{ rows: 1_000, edited: 1 },
	{ rows: 20_000, edited: 1 },
	{ rows: 20_000, edited: 100 },
	{ rows: 20_000, edited: 2_000 },
] as const;

const COMMITS = 41;

console.log('rows\tedited\tno sub (ms)\tsubscribed (ms)\tdelta (ms)\tids seen');
for (const { rows, edited } of CASES) {
	const bare = timeCommits({
		rows,
		edited,
		commits: COMMITS,
		subscribe: false,
	});
	const watched = timeCommits({
		rows,
		edited,
		commits: COMMITS,
		subscribe: true,
	});

	// LIVENESS CONTROL. Every commit must have named every row it edited; a run
	// that collected nothing measured a listener that was not firing.
	const expected = COMMITS * edited;
	if (watched.collected !== expected) {
		throw new Error(
			`the subscribed run collected ${watched.collected} row ids and should have collected ${expected}`,
		);
	}
	if (bare.collected !== 0) {
		throw new Error(
			'the control run collected row ids and should have collected none',
		);
	}

	console.log(
		[
			rows,
			edited,
			bare.medianMs.toFixed(3),
			watched.medianMs.toFixed(3),
			(watched.medianMs - bare.medianMs).toFixed(3),
			watched.collected,
		].join('\t'),
	);
}
