import { defineStore, defineTable, field, plainText } from '@epicenter/app';
/**
 * What the transport does inside `workerd`, measured rather than assumed.
 *
 * Run against a live worker:
 *
 *   bun --cwd apps/sync-lab wrangler dev        # a terminal of its own
 *   bun run packages/app/evidence/data/workerd/probe.ts http://127.0.0.1:8787
 *
 * and against a deployment by passing its origin instead. Nothing here runs in
 * `bun test`, because the thing being measured is the runtime.
 *
 * ## Method
 *
 * Every experiment carries a CONTROL THAT MUST FAIL if the test is not live,
 * and the control is reported beside the result. Three experiments on this
 * branch passed for hollow reasons before anyone noticed: a forged baseline
 * that was rejected for the wrong reason, a cursor rule that "worked" in a
 * simulation where nothing was ever delivered, and a memory table measured with
 * six shapes in one process so the allocator's high-water mark landed on the
 * first. Each was caught because a number looked odd, not because an assertion
 * failed.
 */

import { openMemory } from '@epicenter/app/memory';

import type { DataDocument } from '../../../src/data/store/store.js';
import {
	createSyncClient,
	createSyncConnection,
	DO_SQLITE_VALUE_CAP,
	decodeFrame,
	encodeFrame,
	type Frame,
	type SyncClient,
} from '../../../src/data/sync/index.js';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const application = `probe-${Date.now()}`;

const evidenceDatabase = defineStore({
	id: 'so.epicenter.synclab',
	kv: {},
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				device: field.string(),
				at: field.string(),
			},
			body: plainText(),
		}),
	},
});

type Stat = {
	head: number;
	snapshot: number;
	entries: number;
	storedBytes: number;
	sockets: number;
	incarnation: string;
};

/**
 * One partition's counters.
 *
 * Takes the partition rather than closing over the default, because experiment
 * 5 runs in its own and reading the wrong one reported zero entries and a
 * changed incarnation for a run that was fine. Its controls caught that, which
 * is what they are for.
 */
async function stat(app: string = application): Promise<Stat> {
	const response = await fetch(`${origin}/stat?app=${app}`);
	return (await response.json()) as Stat;
}

async function openReplica() {
	const db = await openMemory(evidenceDatabase);
	return { store: db, db };
}

/** A live socket to the authority, feeding a real client. */
async function connect(client: SyncClient): Promise<WebSocket> {
	const url = new URL('/sync', origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('app', application);
	url.searchParams.set('cursor', String(client.cursor()));
	const socket = new WebSocket(url.toString());
	socket.binaryType = 'arraybuffer';
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') return;
		client.receive(new Uint8Array(event.data as ArrayBuffer));
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve());
		socket.addEventListener('error', () => reject(new Error('socket failed')));
	});
	client.attach({ send: (bytes) => socket.send(bytes) });
	return socket;
}

/** Wait until `check` holds, or give up loudly rather than hanging. */
async function until(
	label: string,
	check: () => boolean | Promise<boolean>,
	timeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function report(label: string, value: unknown): void {
	console.log(`  ${label.padEnd(46)} ${String(value)}`);
}

console.log(`\nworkerd probe against ${origin}, partition ${application}\n`);

// ---------------------------------------------------------------------------

console.log('1. where the value cap actually is, bisected to the byte');
{
	async function stores(
		size: number,
	): Promise<{ stored: boolean; failure?: string }> {
		const response = await fetch(
			`${origin}/probe/value-cap?app=${application}&sizes=${size}`,
		);
		const [outcome] = (await response.json()) as {
			stored: boolean;
			failure?: string;
		}[];
		return outcome ?? { stored: false, failure: 'no answer' };
	}

	const floor = await stores(1_024);
	const ceiling = await stores(8 * 1024 * 1024);
	// The control that has to hold before any boundary below is worth reading. A
	// probe that stores everything, or nothing, is not reaching Durable Object
	// SQLite at all, and a bisection over it would still print a confident
	// number.
	report(
		'CONTROL 1 KB stores and 8 MB does not',
		floor.stored && !ceiling.stored ? 'held' : 'FAILED',
	);
	if (!floor.stored || ceiling.stored)
		throw new Error('the value-cap probe is not live');

	let low = 1_024;
	let high = 8 * 1024 * 1024;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if ((await stores(middle)).stored) low = middle;
		else high = middle;
	}
	report('largest value that stores', low.toLocaleString());
	report(
		'smallest value refused',
		`${high.toLocaleString()}  (${ceiling.failure ?? ''})`,
	);
	report(
		`the documented cap (${DO_SQLITE_VALUE_CAP.toLocaleString()})`,
		low >= DO_SQLITE_VALUE_CAP
			? `fits, with ${(low - DO_SQLITE_VALUE_CAP).toLocaleString()} bytes of headroom`
			: 'DOES NOT FIT: lower CHUNK_BYTES',
	);
}

// ---------------------------------------------------------------------------

console.log('\n2. an update past the cap, through the real socket');
{
	await fetch(`${origin}/probe/reset?app=${application}`);
	const author = await openReplica();
	const reader = await openReplica();
	const authorClient = createSyncClient({ store: author.store, idleMs: 20 });
	const readerClient = createSyncClient({ store: reader.store, idleMs: 20 });
	const authorSocket = await connect(authorClient);
	const readerSocket = await connect(readerClient);

	const note = author.db.tables.notes.create({
		title: 'a big paste',
		device: 'probe',
		at: new Date().toISOString(),
	});
	const text = author.db.tables.notes.body(note.id);
	if (text === undefined) throw new Error('the row has no content');
	// One transaction, well past the cap. There is no seam here for a coalescing
	// bound to cut at, which is why the fix has to be framing at storage.
	text.applyDelta(text.change.insert('x'.repeat(5_000_000)) as never);
	await author.store.persistence.flush();
	authorClient.flush();

	let arrived: { length: number } | undefined;
	await until('the reader to receive the paste', async () => {
		arrived = reader.db.tables.notes.body(note.id);
		return (arrived?.length ?? 0) === 5_000_000;
	});

	const after = await stat();
	report('reassembled length on the OTHER replica', 5_000_000);
	report('head position', after.head);
	report('bytes stored', after.storedBytes.toLocaleString());
	report(
		'chunks it must have taken',
		Math.ceil(after.storedBytes / DO_SQLITE_VALUE_CAP),
	);
	// The control: if the payload had fit in one value, this proves nothing about
	// chunking at all.
	report(
		'CONTROL it really exceeded one value',
		after.storedBytes > DO_SQLITE_VALUE_CAP ? 'held' : 'FAILED',
	);
	report(
		'CONTROL no unresolved dependencies on the reader',
		readerClient.status().unresolvedDependencies ? 'FAILED' : 'held',
	);
	authorSocket.close();
	readerSocket.close();
}

// ---------------------------------------------------------------------------

console.log('\n3. sustained traffic through ONE instance');
{
	await fetch(`${origin}/probe/reset?app=${application}`);
	const messages = Number(process.env.PROBE_MESSAGES ?? '2000');
	const author = await openReplica();
	const reader = await openReplica();
	const authorClient = createSyncClient({ store: author.store, idleMs: 5 });
	const readerClient = createSyncClient({ store: reader.store, idleMs: 5 });
	const authorSocket = await connect(authorClient);
	const readerSocket = await connect(readerClient);

	const before = await stat();
	const startedAt = Date.now();
	let stalledAt: number | undefined;
	for (let index = 0; index < messages; index += 1) {
		const written = author.db.tables.notes.create({
			title: `note ${index}`,
			device: 'probe',
			at: new Date().toISOString(),
		});
		void written;
		// One send per row, deliberately: this experiment is about the authority
		// under load, so it is run with coalescing turned off in effect.
		await author.store.persistence.flush();
		authorClient.flush();
		// The stall is RECORDED rather than thrown on. It is a known open finding
		// and it reproduces; a probe that dies here measures nothing after it,
		// which is how experiment 5 came to be missing for as long as it was.
		const acknowledged = await until(
			`send ${index} to be acknowledged`,
			() => !authorClient.status().inFlight,
		).then(
			() => true,
			() => false,
		);
		if (!acknowledged) {
			stalledAt = index;
			break;
		}
	}
	const elapsed = Date.now() - startedAt;
	const pushed = stalledAt ?? messages;

	await until(
		'the reader to catch up',
		() => readerClient.cursor() >= pushed,
	).catch(() => undefined);
	const after = await stat();

	report(
		'sustained run',
		stalledAt === undefined
			? 'completed'
			: `STALLED at message ${stalledAt}, waiting for an acknowledgement`,
	);
	report('messages pushed', pushed.toLocaleString());
	report('head position', after.head);
	report('snapshot taken at', after.snapshot === 0 ? 'NEVER' : after.snapshot);
	report('entries still in the tail', after.entries);
	report(
		'wall clock',
		`${elapsed} ms  (${(elapsed / Math.max(pushed, 1)).toFixed(2)} ms each)`,
	);
	report('bytes stored', after.storedBytes.toLocaleString());
	report(
		'bytes per entry',
		Math.round(after.storedBytes / Math.max(after.head, 1)),
	);
	report('rows on the OTHER replica', reader.db.tables.notes.ids().length);
	// The control that makes "one instance" mean anything. A run that crossed an
	// eviction measured two cold objects and should not be quoted as sustained.
	report(
		'CONTROL one incarnation start to end',
		before.incarnation === after.incarnation
			? `held  (${after.incarnation.slice(0, 8)})`
			: `FAILED  ${before.incarnation.slice(0, 8)} -> ${after.incarnation.slice(0, 8)}`,
	);
	report(
		'CONTROL every position contiguous, none skipped',
		authorClient.status().lastError === undefined &&
			readerClient.status().lastError === undefined
			? 'held'
			: `FAILED  ${authorClient.status().lastError?.message ?? readerClient.status().lastError?.message}`,
	);
	report(
		'CONTROL the reader holds every row, not just a cursor',
		reader.db.tables.notes.ids().length === pushed ? 'held' : 'FAILED',
	);
	// The whole point of the snapshot: the authority forgets what it covers, so
	// the tail is a fraction of what was pushed rather than all of it.
	report(
		'CONTROL the tail is shorter than the run',
		after.snapshot > 0 && after.entries < pushed
			? `held (${after.entries} of ${pushed} kept)`
			: `FAILED (snapshot ${after.snapshot}, tail ${after.entries})`,
	);
	authorSocket.close();
	readerSocket.close();
}

// ---------------------------------------------------------------------------

console.log('\n4. every submission is answered, and nothing is swallowed');
{
	const url = new URL('/sync', origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('app', application);
	// Far past the head, so catch-up sends nothing and every frame that arrives
	// is an answer to something this experiment pushed.
	url.searchParams.set('cursor', '999999');
	const socket = new WebSocket(url.toString());
	socket.binaryType = 'arraybuffer';
	const answers: Frame[] = [];
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') return;
		const { data: frame } = decodeFrame(
			new Uint8Array(event.data as ArrayBuffer),
		);
		if (frame !== null) answers.push(frame);
	});
	await new Promise<void>((resolve) =>
		socket.addEventListener('open', () => resolve()),
	);

	// Six bytes of garbage, whole in one chunk. The authority never decodes what
	// it stores, so as far as anything on the server can tell this is an ordinary
	// submission, and it is expected to be ACCEPTED. The device that eventually
	// reads it is where the failure becomes visible, by name and by position.
	const headBefore = (await stat()).head;
	socket.send(
		encodeFrame({
			kind: 'push',
			submission: 7,
			chunk: 0,
			chunks: 1,
			bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
		}),
	);
	await until(
		'an answer to the unreadable push',
		() => answers.length > 0,
		15_000,
	).catch(() => undefined);
	const headAfter = (await stat()).head;
	const accepted = answers[0];
	report(
		'bytes the authority cannot read are',
		accepted === undefined
			? 'UNANSWERED (swallowed)'
			: accepted.kind === 'ack'
				? `accepted, at seq ${accepted.seq}`
				: `NOT accepted (${accepted.kind})`,
	);
	// The control: an ack naming a position the log does not hold would be a
	// number the handler invented rather than one storage assigned, and a probe
	// talking to a dead partition would move neither.
	report(
		'CONTROL the log grew by one, at the acked position',
		headAfter === headBefore + 1 &&
			accepted?.kind === 'ack' &&
			accepted.seq === headAfter
			? 'held'
			: `FAILED (${headBefore} -> ${headAfter})`,
	);

	// The refusal that still exists, and the only kind left. Submission 8 opens
	// as three chunks and its second frame claims two, so the collector can no
	// longer know when the submission is whole and drops what it was holding.
	socket.send(
		encodeFrame({
			kind: 'push',
			submission: 8,
			chunk: 0,
			chunks: 3,
			bytes: new Uint8Array([1, 2, 3]),
		}),
	);
	socket.send(
		encodeFrame({
			kind: 'push',
			submission: 8,
			chunk: 1,
			chunks: 2,
			bytes: new Uint8Array([4, 5, 6]),
		}),
	);
	await until(
		'an answer to the mismatched chunk count',
		() => answers.length > 1,
		15_000,
	).catch(() => undefined);
	const refusal = answers[1];
	report(
		'a submission that contradicts its own framing is',
		refusal === undefined
			? 'UNANSWERED (swallowed)'
			: refusal.kind === 'refuse'
				? `refused: ${refusal.reason}`
				: `NOT refused (${refusal.kind})`,
	);
	report(
		'and nothing more was stored',
		(await stat()).head === headAfter ? 'held' : 'FAILED',
	);
	// The control: the socket has to still be open, because the failure this
	// mechanism exists for is a throw that `workerd` swallows WITHOUT closing.
	report(
		'CONTROL the socket is still open',
		socket.readyState === WebSocket.OPEN
			? 'held'
			: `FAILED (state ${socket.readyState})`,
	);
	socket.close();
}

// ---------------------------------------------------------------------------

console.log('\n5. the same regime, driven, so the watchdog can be judged');
{
	// Experiment 3 reproduces a stall nobody has explained: the client stops
	// waiting for an acknowledgement that never comes, with no exception logged
	// anywhere. Four hypotheses were tested and none was it.
	//
	// This is the same stress regime with `createSyncConnection` driving instead
	// of a hand-written loop, so what is being judged is whether a device SURVIVES
	// the stall rather than whether the stall happens. It is not a fix and it is
	// not a diagnosis.
	await fetch(`${origin}/probe/reset?app=${application}-driven`);
	const messages = Number(process.env.PROBE_DRIVEN_MESSAGES ?? '1500');
	const partition = `${application}-driven`;
	const author = await openReplica();
	const reader = await openReplica();

	/** How many sockets each side has opened, which is how a recovery is counted. */
	const dials = { author: 0, reader: 0 };

	function drive(side: 'author' | 'reader', store: DataDocument) {
		return createSyncConnection({
			onRetired() {
				throw new Error('Unexpected retirement in the workerd probe');
			},
			store,
			idleMs: 5,
			// Far shorter than the 30 s default, so a stall inside a probe run
			// costs seconds rather than making the run unreadable.
			unacknowledgedMs: 5_000,
			backoff: () => 250,
			dial: ({ cursor, opened, received, closed }) => {
				dials[side] += 1;
				const url = new URL('/sync', origin);
				url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				url.searchParams.set('app', partition);
				url.searchParams.set('cursor', String(cursor));
				const socket = new WebSocket(url.toString());
				socket.binaryType = 'arraybuffer';
				socket.addEventListener('open', () =>
					opened({ send: (bytes) => socket.send(bytes) }),
				);
				socket.addEventListener('message', (event) => {
					if (typeof event.data === 'string') return;
					received(new Uint8Array(event.data as ArrayBuffer));
				});
				socket.addEventListener('close', () => closed());
				socket.addEventListener('error', () => socket.close());
				return () => socket.close();
			},
		});
	}

	const authorConnection = drive('author', author.store);
	const readerConnection = drive('reader', reader.store);
	authorConnection.start();
	readerConnection.start();
	// CONNECTED, not dialled. The first version of this waited on the dial count,
	// which is incremented before the socket opens, so the whole push loop ran
	// with nothing attached: every send was a no-op, `inFlight` was never true,
	// and 1,200 messages "completed" in 118 ms having measured coalescing rather
	// than the regime. The head control below is what makes that unrepeatable.
	await until(
		'both sockets to open',
		() =>
			authorConnection.status().connected &&
			readerConnection.status().connected,
		15_000,
	);

	const before = await stat(partition);
	const startedAt = Date.now();
	let abandonedAt: number | undefined;
	for (let index = 0; index < messages; index += 1) {
		const written = author.db.tables.notes.create({
			title: `note ${index}`,
			device: 'probe',
			at: new Date().toISOString(),
		});
		void written;
		await author.store.persistence.flush();
		authorConnection.flush();
		// Patience well past one watchdog window plus its backoff, so a stall that
		// the watchdog recovers reads as slow rather than as a failure, and one it
		// cannot recover still ends the run.
		const acknowledged = await until(
			`send ${index} to be acknowledged`,
			() => !authorConnection.status().inFlight,
			45_000,
		).then(
			() => true,
			() => false,
		);
		if (!acknowledged) {
			abandonedAt = index;
			break;
		}
	}
	const elapsed = Date.now() - startedAt;
	const pushed = abandonedAt ?? messages;

	await until(
		'the reader to catch up',
		() => reader.db.tables.notes.ids().length >= pushed,
		60_000,
	).catch(() => undefined);
	const after = await stat(partition);

	report(
		'driven run',
		abandonedAt === undefined
			? 'completed'
			: `ABANDONED at message ${abandonedAt}, unrecovered`,
	);
	report('messages pushed', pushed.toLocaleString());
	report(
		'wall clock',
		`${elapsed} ms  (${(elapsed / Math.max(pushed, 1)).toFixed(2)} ms each)`,
	);
	report(
		'sockets the author opened',
		`${dials.author}  (${dials.author - 1} reconnect${dials.author === 2 ? '' : 's'})`,
	);
	report(
		'last reconnect reason',
		authorConnection.status().lastReconnect ?? 'none',
	);
	// The control that makes this the same regime as experiment 3 rather than a
	// different one. One send per row means one ENTRY per row; a run whose sends
	// were merged into a handful of entries measured coalescing, which is a
	// different experiment and a much easier one.
	const entriesAdded = after.head - before.head;
	report(
		'CONTROL one entry per message, so sends were not merged',
		entriesAdded >= pushed
			? `held  (${entriesAdded} entries for ${pushed} messages)`
			: `FAILED  (${entriesAdded} entries for ${pushed} messages)`,
	);
	// The control this whole section rests on: a run that pushed nothing, or a
	// reader that holds a cursor rather than rows, would report a clean recovery
	// while having carried no data at all.
	report(
		'CONTROL the reader holds every row, not just a cursor',
		reader.db.tables.notes.ids().length === pushed
			? `held  (${pushed} rows)`
			: `FAILED  (${reader.db.tables.notes.ids().length} of ${pushed})`,
	);
	report(
		'CONTROL one incarnation start to end',
		before.incarnation === after.incarnation ? 'held' : 'FAILED',
	);
	authorConnection[Symbol.dispose]();
	readerConnection[Symbol.dispose]();
}

console.log('\ndone\n');
process.exit(0);
