/**
 * What a durable write costs: append log against whole-document replacement,
 * and an id-outbox against a state-vector watermark on the wire.
 *
 * Two questions this exists to answer with numbers rather than assertion:
 *
 * 1. `log.ts` says re-encoding a whole document is "cheap at the sizes a
 *    personal database reaches". That is an assertion. At what document size
 *    does whole-document replacement stop being cheap, against the append
 *    chain that folds at `SNAPSHOT_FOLD_THRESHOLD`?
 * 2. Replacing the id-addressed outbox with `encodeStateSince(watermark)`
 *    sends everything the document holds that the watermark does not, which
 *    INCLUDES work that arrived from a peer. How much redundant upload is
 *    that, and does the fix (a watermark that also absorbs remote applies)
 *    earn its bookkeeping?
 *
 * Everything runs against real IndexedDB in a real browser, because the cost
 * under test is structured clone plus disk, not arithmetic.
 */
import * as Y from '@y/y';

// ---------------------------------------------------------------- primitives

/** Deterministic, so every strategy replays the identical edit stream. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

const WORDS =
	'the quick brown fox jumps over a lazy dog while thinking about notes sync storage and the shape of a durable record'.split(
		' ',
	);

function sentence(next: () => number, words: number): string {
	let out = '';
	for (let i = 0; i < words; i += 1) {
		out += `${WORDS[Math.floor(next() * WORDS.length)]} `;
	}
	return out;
}

function now(): number {
	return performance.now();
}

// ------------------------------------------------------------------- indexeddb

const DB_NAME = 'write-cost';
const STORE = 'rows';

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function tx(
	db: IDBDatabase,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		run(transaction.objectStore(STORE));
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

function readAll(db: IDBDatabase, prefix: string): Promise<Uint8Array[]> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, 'readonly');
		const request = transaction
			.objectStore(STORE)
			.getAll(IDBKeyRange.bound(`${prefix}:`, `${prefix}:￿`));
		request.onsuccess = () => resolve(request.result as Uint8Array[]);
		request.onerror = () => reject(request.error);
	});
}

async function clearPrefix(db: IDBDatabase, prefix: string): Promise<void> {
	await tx(db, 'readwrite', (store) => {
		store.delete(IDBKeyRange.bound(`${prefix}:`, `${prefix}:￿`));
	});
}

/** Zero-padded so an IndexedDB key range walks the chain in write order. */
function seqKey(prefix: string, seq: number): string {
	return `${prefix}:${String(seq).padStart(9, '0')}`;
}

// ------------------------------------------------------------------- workspace

type Config = {
	notes: number;
	bodyWords: number;
	edits: number;
	editWords: number;
	foldEvery: number;
	debounceEvery: number;
	sendEvery: number;
	remotePerRound: number;
	controlEvery: number;
	seed: number;
};

type Note = { root: Y.Type; id: string };

/**
 * One document, N rows, each row carrying a rich content node. The nested
 * grammar of ADR-0295, because `doc.share` size is what makes encoding
 * quadratic and a flat root-per-row would measure the wrong thing.
 */
function buildWorkspace(config: Config): { doc: Y.Doc; notes: Note[] } {
	const doc = new Y.Doc({ gc: true });
	const table = doc.get('tables:notes');
	const notes: Note[] = [];
	const next = rng(config.seed);
	doc.transact(() => {
		for (let i = 0; i < config.notes; i += 1) {
			const id = `note-${String(i).padStart(6, '0')}`;
			const row = new Y.Type();
			row.setAttr('title', sentence(next, 4).trim() as never);
			row.setAttr('createdAt', (1700000000000 + i * 60000) as never);
			const content = new Y.Type();
			content.insert(0, sentence(next, config.bodyWords));
			row.setAttr('content', content as never);
			table.setAttr(id, row as never);
			notes.push({ root: content, id });
		}
	});
	return { doc, notes };
}

/** One keystroke burst into a random note, the way a person actually writes. */
function applyEdit(
	doc: Y.Doc,
	notes: Note[],
	next: () => number,
	words: number,
): void {
	const note = notes[Math.floor(next() * notes.length)];
	if (note === undefined) return;
	doc.transact(() => {
		note.root.insert(note.root.length, sentence(next, words));
	});
}

// -------------------------------------------------------------- disk strategies

type DiskResult = {
	strategy: string;
	transactions: number;
	bytesWritten: number;
	encodeMs: number;
	commitMs: number;
	finalRows: number;
	finalBytes: number;
	hydrateMs: number;
	peakSnapshotBytes: number;
};

/**
 * Today: every update is a row; the chain folds into one baseline every
 * `foldEvery` appends by re-encoding the whole document and deleting what it
 * replaced. This is `log.ts` with `SNAPSHOT_FOLD_THRESHOLD` as the dial.
 */
async function runAppendLog(
	db: IDBDatabase,
	config: Config,
): Promise<DiskResult> {
	const prefix = 'append';
	await clearPrefix(db, prefix);
	const { doc, notes } = buildWorkspace(config);
	const next = rng(config.seed + 1);

	let transactions = 0;
	let bytesWritten = 0;
	let encodeMs = 0;
	let commitMs = 0;
	let seq = 0;
	let sinceFold = 0;
	let peak = 0;

	const pending: Uint8Array[] = [];
	doc.on('updateV2', (update: Uint8Array) => {
		pending.push(update);
	});

	// The baseline the session starts from, as a real workspace would open.
	const opening = Y.encodeStateAsUpdateV2(doc);
	peak = Math.max(peak, opening.byteLength);
	await tx(db, 'readwrite', (store) => {
		store.put(opening, seqKey(prefix, seq));
	});
	seq += 1;
	transactions += 1;
	bytesWritten += opening.byteLength;

	for (let i = 0; i < config.edits; i += 1) {
		pending.length = 0;
		applyEdit(doc, notes, next, config.editWords);
		const update = pending[0];
		if (update === undefined) continue;

		if (sinceFold + 1 < config.foldEvery) {
			const start = now();
			await tx(db, 'readwrite', (store) => {
				store.put(update, seqKey(prefix, seq));
			});
			commitMs += now() - start;
			seq += 1;
			sinceFold += 1;
			transactions += 1;
			bytesWritten += update.byteLength;
			continue;
		}

		// Fold: re-encode the whole document, write it as the new baseline, and
		// forget every row it covers. Exactly `log.ts`'s fold.
		const encodeStart = now();
		const folded = Y.encodeStateAsUpdateV2(doc);
		encodeMs += now() - encodeStart;
		peak = Math.max(peak, folded.byteLength);
		const commitStart = now();
		await tx(db, 'readwrite', (store) => {
			store.delete(IDBKeyRange.bound(`${prefix}:`, `${prefix}:￿`));
			store.put(folded, seqKey(prefix, 0));
		});
		commitMs += now() - commitStart;
		seq = 1;
		sinceFold = 0;
		transactions += 1;
		bytesWritten += folded.byteLength;
	}

	const rows = await readAll(db, prefix);
	const hydrateStart = now();
	const rebuilt = new Y.Doc({ gc: true });
	for (const row of rows) Y.applyUpdateV2(rebuilt, new Uint8Array(row), null);
	const hydrateMs = now() - hydrateStart;

	return {
		strategy:
			config.foldEvery > config.edits
				? 'append log, NEVER folds'
				: `append log, fold every ${config.foldEvery}`,
		transactions,
		bytesWritten,
		encodeMs,
		commitMs,
		finalRows: rows.length,
		finalBytes: rows.reduce((total, row) => total + row.byteLength, 0),
		hydrateMs,
		peakSnapshotBytes: peak,
	};
}

/**
 * Incremental appends, batched: the updates accumulated since the last idle
 * tick go into ONE transaction, and nothing is ever folded. This is the
 * cheapest write path available, and the honest competitor to whole-document
 * replacement once both are debounced the same way.
 */
async function runAppendBatched(
	db: IDBDatabase,
	config: Config,
	batchEvery: number,
): Promise<DiskResult> {
	const prefix = 'batched';
	await clearPrefix(db, prefix);
	const { doc, notes } = buildWorkspace(config);
	const next = rng(config.seed + 1);

	let transactions = 0;
	let bytesWritten = 0;
	let commitMs = 0;
	let seq = 0;

	const pending: Uint8Array[] = [];
	doc.on('updateV2', (update: Uint8Array) => {
		pending.push(update);
	});

	async function drain(): Promise<void> {
		if (pending.length === 0) return;
		const batch = pending.splice(0, pending.length);
		const start = now();
		await tx(db, 'readwrite', (store) => {
			for (const update of batch) {
				store.put(update, seqKey(prefix, seq));
				seq += 1;
			}
		});
		commitMs += now() - start;
		transactions += 1;
		for (const update of batch) bytesWritten += update.byteLength;
	}

	const opening = Y.encodeStateAsUpdateV2(doc);
	pending.length = 0;
	await tx(db, 'readwrite', (store) => {
		store.put(opening, seqKey(prefix, seq));
	});
	seq += 1;
	transactions += 1;
	bytesWritten += opening.byteLength;

	for (let i = 0; i < config.edits; i += 1) {
		applyEdit(doc, notes, next, config.editWords);
		if ((i + 1) % batchEvery === 0) await drain();
	}
	await drain();

	const rows = await readAll(db, prefix);
	const hydrateStart = now();
	const rebuilt = new Y.Doc({ gc: true });
	for (const row of rows) Y.applyUpdateV2(rebuilt, new Uint8Array(row), null);
	const hydrateMs = now() - hydrateStart;

	return {
		strategy: `appends batched every ${batchEvery}, never folds`,
		transactions,
		bytesWritten,
		encodeMs: 0,
		commitMs,
		finalRows: rows.length,
		finalBytes: rows.reduce((total, row) => total + row.byteLength, 0),
		hydrateMs,
		peakSnapshotBytes: opening.byteLength,
	};
}

/**
 * The destination: no chain, no ids, no ordering. One row holding the whole
 * document, rewritten on an idle tick. `debounceEvery` stands in for the idle
 * timer, since a benchmark cannot wait out a real one.
 */
async function runWholeDocument(
	db: IDBDatabase,
	config: Config,
	debounceEvery: number,
	label: string,
): Promise<DiskResult> {
	const prefix = `whole-${debounceEvery}`;
	await clearPrefix(db, prefix);
	const { doc, notes } = buildWorkspace(config);
	const next = rng(config.seed + 1);

	let transactions = 0;
	let bytesWritten = 0;
	let encodeMs = 0;
	let commitMs = 0;
	let peak = 0;

	async function write(): Promise<void> {
		const encodeStart = now();
		const whole = Y.encodeStateAsUpdateV2(doc);
		encodeMs += now() - encodeStart;
		peak = Math.max(peak, whole.byteLength);
		const commitStart = now();
		await tx(db, 'readwrite', (store) => {
			store.put(whole, `${prefix}:document`);
		});
		commitMs += now() - commitStart;
		transactions += 1;
		bytesWritten += whole.byteLength;
	}

	await write();
	for (let i = 0; i < config.edits; i += 1) {
		applyEdit(doc, notes, next, config.editWords);
		if ((i + 1) % debounceEvery === 0) await write();
	}
	await write();

	const rows = await readAll(db, prefix);
	const hydrateStart = now();
	const rebuilt = new Y.Doc({ gc: true });
	for (const row of rows) Y.applyUpdateV2(rebuilt, new Uint8Array(row), null);
	const hydrateMs = now() - hydrateStart;

	return {
		strategy: label,
		transactions,
		bytesWritten,
		encodeMs,
		commitMs,
		finalRows: rows.length,
		finalBytes: rows.reduce((total, row) => total + row.byteLength, 0),
		hydrateMs,
		peakSnapshotBytes: peak,
	};
}

// -------------------------------------------------------------- wire strategies

type WireResult = {
	strategy: string;
	sends: number;
	bytesSent: number;
	computeMs: number;
	note: string;
};

/**
 * What the sender puts on the socket, with a peer producing traffic we apply
 * between our own sends. The DO is byte-blind either way; what differs is how
 * many bytes each strategy hands it.
 */
async function runWire(config: Config): Promise<WireResult[]> {
	const rounds = Math.floor(config.edits / config.sendEvery);

	// Three senders, identical edit streams, so the byte counts are comparable.
	function session() {
		const { doc, notes } = buildWorkspace(config);
		const peer = new Y.Doc({ gc: true });
		Y.applyUpdateV2(peer, Y.encodeStateAsUpdateV2(doc), null);
		const peerNotes: Note[] = [];
		const peerTable = peer.get('tables:notes');
		for (const note of notes) {
			const row = peerTable.getAttr(note.id) as unknown as Y.Type;
			peerNotes.push({
				root: row.getAttr('content') as unknown as Y.Type,
				id: note.id,
			});
		}
		return { doc, notes, peer, peerNotes };
	}

	// --- id-outbox: exactly the bytes this device authored, merged.
	const outbox = (() => {
		const { doc, notes, peer, peerNotes } = session();
		const next = rng(config.seed + 2);
		const peerNext = rng(config.seed + 99);
		const authored: Uint8Array[] = [];
		doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
			if (origin === 'remote') return;
			authored.push(update);
		});
		let bytesSent = 0;
		let computeMs = 0;
		let sends = 0;
		for (let round = 0; round < rounds; round += 1) {
			for (let i = 0; i < config.sendEvery; i += 1) {
				applyEdit(doc, notes, next, config.editWords);
			}
			for (let i = 0; i < config.remotePerRound; i += 1) {
				const before = Y.encodeStateVector(peer);
				applyEdit(peer, peerNotes, peerNext, config.editWords);
				const delta = Y.encodeStateAsUpdateV2(peer, before);
				Y.applyUpdateV2(doc, delta, 'remote');
			}
			if (authored.length === 0) continue;
			const start = now();
			const payload = Y.mergeUpdatesV2(
				authored.splice(0, authored.length).map((u) => new Uint8Array(u)),
			);
			computeMs += now() - start;
			bytesSent += payload.byteLength;
			sends += 1;
		}
		return {
			strategy: 'id-outbox: mergeUpdatesV2 of authored updates',
			sends,
			bytesSent,
			computeMs,
			note: 'sends only what this device wrote; needs ids, rows, and ack bookkeeping',
		};
	})();

	// --- naive watermark: everything the doc holds that the last ack did not.
	const naive = (() => {
		const { doc, notes, peer, peerNotes } = session();
		const next = rng(config.seed + 2);
		const peerNext = rng(config.seed + 99);
		let watermark = Y.encodeStateVector(doc);
		let bytesSent = 0;
		let computeMs = 0;
		let sends = 0;
		for (let round = 0; round < rounds; round += 1) {
			for (let i = 0; i < config.sendEvery; i += 1) {
				applyEdit(doc, notes, next, config.editWords);
			}
			for (let i = 0; i < config.remotePerRound; i += 1) {
				const before = Y.encodeStateVector(peer);
				applyEdit(peer, peerNotes, peerNext, config.editWords);
				const delta = Y.encodeStateAsUpdateV2(peer, before);
				Y.applyUpdateV2(doc, delta, 'remote');
			}
			const start = now();
			const sending = Y.encodeStateVector(doc);
			const payload = Y.encodeStateAsUpdateV2(doc, watermark);
			computeMs += now() - start;
			bytesSent += payload.byteLength;
			sends += 1;
			watermark = sending;
		}
		return {
			strategy: 'watermark, naive: encodeStateSince(last ack)',
			sends,
			bytesSent,
			computeMs,
			note: 'no ids and no outbox rows, but re-uploads peer work it just received',
		};
	})();

	// --- corrected watermark: absorbs remote applies, so peer work is never
	// echoed back. Modelled with a shadow doc; a real implementation merges
	// state-vector maps, which is cheaper than this measurement implies.
	const corrected = (() => {
		const { doc, notes, peer, peerNotes } = session();
		const next = rng(config.seed + 2);
		const peerNext = rng(config.seed + 99);
		const known = new Y.Doc({ gc: true });
		Y.applyUpdateV2(known, Y.encodeStateAsUpdateV2(doc), null);
		let bytesSent = 0;
		let computeMs = 0;
		let sends = 0;
		for (let round = 0; round < rounds; round += 1) {
			for (let i = 0; i < config.sendEvery; i += 1) {
				applyEdit(doc, notes, next, config.editWords);
			}
			for (let i = 0; i < config.remotePerRound; i += 1) {
				const before = Y.encodeStateVector(peer);
				applyEdit(peer, peerNotes, peerNext, config.editWords);
				const delta = Y.encodeStateAsUpdateV2(peer, before);
				Y.applyUpdateV2(doc, delta, 'remote');
				// The authority sent us this entry, so it demonstrably holds it.
				Y.applyUpdateV2(known, delta, null);
			}
			const start = now();
			const payload = Y.encodeStateAsUpdateV2(doc, Y.encodeStateVector(known));
			computeMs += now() - start;
			bytesSent += payload.byteLength;
			sends += 1;
			Y.applyUpdateV2(known, payload, null);
		}
		return {
			strategy: 'watermark, corrected: absorbs remote applies',
			sends,
			bytesSent,
			computeMs,
			note: 'matches the outbox on the wire; costs state-vector merge bookkeeping',
		};
	})();

	return [outbox, naive, corrected];
}

// -------------------------------------------------------------------- reporting

function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function ms(value: number): string {
	return `${value.toFixed(1)} ms`;
}

function readConfig(): Config {
	const value = (id: string): number =>
		Number((document.getElementById(id) as HTMLInputElement).value);
	return {
		notes: value('notes'),
		bodyWords: value('bodyWords'),
		edits: value('edits'),
		editWords: value('editWords'),
		foldEvery: value('foldEvery'),
		debounceEvery: value('debounceEvery'),
		sendEvery: value('sendEvery'),
		remotePerRound: value('remotePerRound'),
		controlEvery: value('controlEvery'),
		seed: 20260831,
	};
}

function status(text: string): void {
	const node = document.getElementById('status');
	if (node !== null) node.textContent = text;
}

function renderDisk(results: DiskResult[], baseline: number): void {
	const best = Math.min(...results.map((r) => r.bytesWritten));
	const rows = results
		.map((result) => {
			const flag = result.bytesWritten === best ? ' class="best"' : '';
			return `<tr${flag}>
				<td class="name">${result.strategy}</td>
				<td>${result.transactions}</td>
				<td>${bytes(result.bytesWritten)}</td>
				<td>${(result.bytesWritten / baseline).toFixed(1)}×</td>
				<td>${ms(result.encodeMs)}</td>
				<td>${ms(result.commitMs)}</td>
				<td>${result.finalRows}</td>
				<td>${bytes(result.finalBytes)}</td>
				<td>${ms(result.hydrateMs)}</td>
			</tr>`;
		})
		.join('');
	const node = document.getElementById('disk');
	if (node === null) return;
	node.innerHTML = `<table>
		<thead><tr>
			<th>strategy</th><th>IDB txns</th><th>bytes written</th>
			<th>write amp</th><th>encode</th><th>commit</th>
			<th>rows left</th><th>stored</th><th>hydrate</th>
		</tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

function renderWire(results: WireResult[]): void {
	const best = Math.min(...results.map((r) => r.bytesSent));
	const rows = results
		.map((result) => {
			const flag = result.bytesSent === best ? ' class="best"' : '';
			return `<tr${flag}>
				<td class="name">${result.strategy}<div class="note">${result.note}</div></td>
				<td>${result.sends}</td>
				<td>${bytes(result.bytesSent)}</td>
				<td>${(result.bytesSent / best).toFixed(2)}×</td>
				<td>${ms(result.computeMs)}</td>
			</tr>`;
		})
		.join('');
	const node = document.getElementById('wire');
	if (node === null) return;
	node.innerHTML = `<table>
		<thead><tr>
			<th>strategy</th><th>sends</th><th>bytes on the wire</th>
			<th>vs best</th><th>compute</th>
		</tr></thead>
		<tbody>${rows}</tbody>
	</table>`;
}

async function run(): Promise<void> {
	const button = document.getElementById('run') as HTMLButtonElement;
	button.disabled = true;
	try {
		const config = readConfig();
		const db = await openDb();

		status('building the workspace…');
		const { doc } = buildWorkspace(config);
		const baseline = Y.encodeStateAsUpdateV2(doc).byteLength;
		const node = document.getElementById('baseline');
		if (node !== null) {
			node.textContent = `${config.notes} notes, ${bytes(baseline)} encoded, ${config.edits} edits`;
		}

		status('append log…');
		const append = await runAppendLog(db, config);
		status('whole document, debounced…');
		const whole = await runWholeDocument(
			db,
			config,
			config.debounceEvery,
			`whole document, every ${config.debounceEvery} edits`,
		);
		status('appends batched…');
		const batched = await runAppendBatched(db, config, config.debounceEvery);
		const results = [append, batched, whole];
		if (config.controlEvery > 0) {
			status('whole document, every edit…');
			results.push(
				await runWholeDocument(
					db,
					config,
					config.controlEvery,
					`whole document, every ${config.controlEvery} edits (control)`,
				),
			);
		}
		renderDisk(results, baseline);

		status('wire strategies…');
		renderWire(await runWire(config));

		status('done');
	} catch (cause) {
		status(`failed: ${String(cause)}`);
		throw cause;
	} finally {
		button.disabled = false;
	}
}

document.getElementById('run')?.addEventListener('click', () => void run());
status('ready');
