/**
 * The repository's property test, run over any world: in memory
 * (`property.test.ts`) or over the real wire (`wire.property.test.ts`).
 *
 * Three people and one agent edit a few notes over a lossy, reordering
 * network whose messages sometimes stall past a request's timeout, through
 * seeded random steps: typing in the body and the frontmatter, breaking and
 * repairing frontmatter (a broken one syncs as it is), setting one field from several devices, a stale
 * editor buffer saved late, a note too large to store, renames (delete plus
 * write), deletes, deleting a path and creating it again (sometimes with the
 * very text it had before), an agent's saves (several notes in one
 * transaction, sometimes with a new blob, each file going on its own and
 * merged by the same rule as everyone's),
 * lost replies, offline periods, restarts, flushes, idle periods longer than
 * the retention window, catch-ups in pages of two paths, a device whose storage
 * is lost for good, a hostile member writing directly to the server, and
 * blobs: attaching bytes at a named path (alone, or with a note naming it),
 * deleting them, and the upload track's steps out of order and across
 * disconnects (the server receiving bytes, a device hearing they are
 * present, an upload failing, an upload refused).
 * Then everyone comes online, repairs what does not fit and saves what they hold back, and the
 * network goes quiet.
 *
 * Every step is a word token (`t<n>z`), so the test can say exactly what was
 * typed. A token is *owed* once a writer saved it on their device. It is *acknowledged* once a
 * commit holding it was answered applied or merged. It stops being owed when
 * a person removes a copy of it from what their editor showed and saved
 * (deleting the word, the file, or overwriting the field; a rename moves it):
 * a deliberate removal, whoever typed it. Notices hold no values: a value
 * counts only where the server or a device keeps it as text.
 *
 * Key behaviors:
 * - An acknowledged token is in a server text after every step, or in a device's unsent work (a rename's new file, held or not yet sent, after its delete went alone), and at quiescence every owed token is in a server text
 * - Before it is acknowledged, a token is in a server text or on a surviving device; a lost device loses only what was never acknowledged, or what only its own unsent work held
 * - A person's removal (a delete, or a rename's old path) makes the path absent on the server, by their commit or another's, unless it lost to an edit by someone else that it had not seen: then the edited file stays, and nothing typed is lost
 * - No stale edit of a note merges silently across a delete: if the path was deleted, or created by someone else, since the commit's parent, the edit lands whole in a conflict block; a blob write lands in a merge only over the bytes its writer saw, or bytes equal to its own (compare-and-swap)
 * - Every server Markdown file is at most 1 MB (one whose frontmatter does not parse is a note with no fields, and syncs); hostile writes (forged author, non-member, oversized, CRLF endings, replayed id with other files, a flood of stale-parent commits) are refused or bounded
 * - At quiescence every device's mine and base equal the server's text for every path
 * - None applied twice: at quiescence no token appears twice in a server text outside its conflict blocks, nor twice in any one side of a block (`versionsOf`), except tokens a person wrote twice on purpose (resolving blocks by keeping every side's lines)
 * - Held alone: once everyone is online and every upload is completed or refused, every file a device has not sent is held, with a reason of its own; nothing waits on another file
 * - Blobs: the server's main never holds a pointer whose bytes it lacks at that size; no device sends a pointer before it marked its bytes present, unless it is the pointer main gave it at that path; at quiescence, with every upload completed or refused, every attach not replaced, deleted or discarded by its person landed
 *
 * Each suite reads its own environment, by prefix (B for the memory
 * suite, W for the wire): <P>_SEED=n replays one sequence, <P>_RUNS=n runs n
 * seeds from <P>_FROM (default 1), <P>_STEPS=n sets the steps per seed.
 * A failure names its seed and the steps.
 */
import { expect, test } from 'bun:test';
import { parseMarkdown, parsePointer, splitMarkdown, writeMarkdown, writePointer } from '../core/markdown.js';
import { conflictSibling } from '../core/settle.js';
import type { MemoryGitStore } from '../server/memory-git.js';
import type { Server } from '../server/server.js';
import { type Device, STAMP, type World, createWorld } from './harness.js';
import { escapeLines, findConflicts } from '../core/conflict.js';
import { createRandom } from './net.js';
import { commitId, type LiveCommit } from '../core/commit.js';
import { MAIN } from '../server/git-store.js';
import { type Committed, LIMITS, type PushAnswer, REASONS } from '../server/server.js';
import { UPLOADING } from '../client/replica.js';

/**
 * What the property test needs of a world: the memory harness's surface,
 * with virtual time stepped asynchronously so a world doing real I/O can
 * finish it between events.
 */
export type PropertyWorld = {
	server: Server;
	git: MemoryGitStore;
	device: World['device'];
	session: World['session'];
	flush: World['flush'];
	calm: World['calm'];
	onCommit: World['onCommit'];
	onRequest: World['onRequest'];
	counts(): Record<string, number>;
	/** Virtual time, in ms. */
	now(): number;
	runFor(ms: number): Promise<void>;
	/** Run until nothing is left to do; false if it never went idle. */
	settle(): Promise<boolean>;
	close(): Promise<void>;
};
export type WorldOptions = NonNullable<Parameters<typeof createWorld>[0]>;

/** The memory harness as a property world. */
export const memoryWorld = (options: WorldOptions): PropertyWorld => {
	const world = createWorld(options);
	return {
		...world,
		now: world.net.now,
		runFor: async (ms) => world.net.runFor(ms),
		settle: async () => world.settle(),
		close: async () => {},
	};
};

const PATHS = ['notes/a.md', 'notes/b.md', 'notes/c.md'];
/** Blob paths, and the bytes devices attach at them (as oid and size: the bytes themselves are the upload track's). */
const BLOB_PATHS = ['recordings/r1.webm', 'recordings/r2.webm'];
const BYTES = ['a', 'b', 'c', 'd'].map((x, i) => ({ oid: x.repeat(64), size: 100 * (i + 1) }));
const REFUSED = 'refused by the server';
/** A note created from a template: the same text each time, so a path can hold a new note with an old note's text. */
const TEMPLATE = '---\ntitle: New\n---\n';
const TOKEN = /t\d+z/g;
/** Filler that makes a note larger than the 1 MB a note may be. */
const FILLER = `big ${'x'.repeat(1_100_000)}`;
/** `hasFiller(text)` is pathologically slow in JavaScriptCore on a long text of x's, so look for it this way. */
const hasFiller = (text: string) => /x{1000}/.test(text);
/** Whether a text's fences, if any, hold parseable frontmatter. A text where they do not is a note all the same, with no fields. */
const opensParsed = (text: string) => splitMarkdown(text).yaml === null || parseMarkdown(text).hasFrontmatter;
/** Pushes a member makes in one burst; the server's admission limit must hold a flood below the bound. */
const FLOOD = 60;
const FLOOD_BOUND = 30;

const tokensIn = (text: string | null) => new Set(text?.match(TOKEN) ?? []);

/**
 * The texts in which no token may appear twice: a file's text outside its
 * conflict blocks, and each side of each block, read the same way (a side
 * may hold blocks of its own, escaped). A block's base section repeats the
 * base by design and is not counted; nor are two sides counted together, or
 * a side with the text around it: the core merge keeps an existing block
 * whole beside a new one, and keeps both bodies of two creates, so a block's
 * side repeats lines the text around it has (both by design, `core/merge.ts`).
 */
export function versionsOf(text: string, where = 'outside blocks'): [string, string][] {
	const blocks = findConflicts(text);
	let outside = '';
	let at = 0;
	for (const block of blocks) {
		outside += text.slice(at, block.from);
		at = block.to;
	}
	outside += text.slice(at);
	return [
		[where, outside],
		...blocks.flatMap((block) => [...versionsOf(block.current, `block at line ${block.line}, current`), ...versionsOf(block.incoming, `block at line ${block.line}, incoming`)]),
	];
}

const counts = (texts: (string | null)[]) => {
	const out = new Map<string, number>();
	for (const text of texts) for (const t of text?.match(TOKEN) ?? []) out.set(t, (out.get(t) ?? 0) + 1);
	return out;
};

/** Make a text's frontmatter parse and the text fit without losing a token: close the quotes this test opens, drop the filler, then move frontmatter lines that still fail into the body. */
function repair(text: string) {
	let fixed = text.replaceAll(': "open\n', ': "shut"\n').replace(/x{1000,}/g, '');
	for (let guard = 0; !opensParsed(fixed) && guard < 200; guard++) {
		const { yaml, bodyStart } = splitMarkdown(fixed);
		if (yaml === null) break;
		const lines = yaml.split('\n').filter((line) => line !== '');
		const moved = lines.pop() ?? '';
		fixed = `---\n${lines.map((l) => `${l}\n`).join('')}---\n${moved}\n${fixed.slice(bodyStart)}`;
	}
	return fixed;
}

async function run(seed: number, makeWorld: (options: WorldOptions) => PropertyWorld | Promise<PropertyWorld>, STEPS: number) {
	const random = createRandom(seed * 7919 + 13);
	const log: string[] = [];
	const tracing = process.env.B_TRACE !== undefined;
	const world = await makeWorld({
		seed,
		latency: { min: 5, max: 120 },
		loss: { up: 0.05, down: 0.08 },
		streamLoss: 0.04,
		stall: { chance: 0.03, ms: 4_000 },
		timeout: 1_500,
		// Pages of two paths, so a catch-up of more comes in several, and a push can land between them.
		limits: { page: 2 },
		...(tracing ? { trace: (line: string) => log.push(line) } : {}),
	});
	const people = ['alice', 'bob', 'carol'].map((name) => world.device(name));
	const agent = world.device('agent');
	const everyone: Device[] = [...people, agent];
	/** Owed tokens, with who typed them. */
	const owed = new Map<string, string>();
	const acknowledged = new Set<string>();
	const removed = new Set<string>();
	/** Typed on a device lost before its commit was acknowledged: legitimately gone. */
	const forgotten = new Set<string>();
	/** Acknowledged tokens whose only copy was a device's unsent work when its storage was lost: the cost of each file going on its own. */
	let lostWithUnsent = 0;
	/** Tokens a person deliberately wrote twice: resolving a note's blocks by keeping every side's lines. */
	const retyped = new Set<string>();
	const removals: { device: string; path: string; base: string | null; position: string | null; at: number; landed: boolean; cancelled: boolean; step: string }[] = [];
	const violations: string[] = [];
	/** Bytes each device was told are present (its "epicenter/objects"), by device. */
	const marked = new Map<string, Set<string>>();
	/** Bytes the server refuses, whoever asks. */
	const refusedBytes = new Set<string>();
	/** Each blob a person attached: done once that text is on main at that path (theirs, or the same bytes from someone else); settled otherwise only by their own later save of the path, a discard, or losing the device. */
	const attaches: { device: string; path: string; text: string; settled: boolean }[] = [];
	/** Every blob text main has held, by path. */
	const onMain = new Set<string>();
	const honestIds: string[] = [];
	let next = 1;
	const token = () => `t${next++}z`;

	// The test's own copy of history: each commit's files, to judge merges independently of the server.
	const states = new Map<string, Map<string, string>>([[world.server.main(), new Map()]]);
	const chain: string[] = [world.server.main()];
	/** Who wrote each commit on the chain, and the paths it changed. */
	const writers: { user: string; paths: Set<string> }[] = [{ user: '', paths: new Set() }];
	let lastMerge: Committed | null = null;
	world.onCommit((committed) => {
		const state = new Map(states.get(committed.parents[0] ?? '') ?? []);
		for (const file of committed.files) {
			if (file.after !== null && file.after.length > 1024 * 1024) violations.push(`server: ${file.path} is ${file.after.length} bytes`);
			// A removal is done once its path is absent on the server after it, whoever's commit did it.
			if (file.after === null) for (const r of removals) if (r.path === file.path && !r.cancelled) r.landed = true;
			const pointer = file.after === null ? null : parsePointer(file.after);
			if (pointer !== null && world.server.uploaded(pointer.oid) !== pointer.size) violations.push(`server: main holds ${file.path} without its bytes (${pointer.oid.slice(0, 8)})`);
			if (pointer !== null) onMain.add(`${file.path}\0${file.after}`);
			if (file.after === null) state.delete(file.path);
			else state.set(file.path, file.after);
		}
		states.set(committed.id, state);
		chain.push(committed.id);
		writers.push({ user: committed.author.user, paths: new Set(committed.files.map((f) => f.path)) });
		lastMerge = committed.parents.length > 1 ? committed : null;
	});
	world.onRequest((device, request, reply) => {
		if (request.type === 'push')
			for (const file of request.commit.files) {
				const pointer = file.text === null ? null : parsePointer(file.text);
				// Bytes this device heard are present, or the pointer `main` gave it at that path (its base): main admits a pointer only once the server holds its bytes.
				const base = everyone.find((d) => d.name === device)?.replica.files().get(file.path)?.base ?? null;
				if (pointer !== null && !marked.get(device)?.has(pointer.oid) && file.text !== base) violations.push(`${device}: sent ${file.path} before its bytes were present`);
			}
		if (request.type !== 'push' || reply.type !== 'answer') return;
		const answer = reply.answer as PushAnswer;
		if (answer.kind !== 'applied' && answer.kind !== 'merged') return;
		const commit = request.commit;
		honestIds.push(commit.id);
		for (const file of commit.files) for (const t of tokensIn(file.text)) acknowledged.add(t);
		// No silent merge across a delete, judged by the test's own history; a blob, which never merges, by compare-and-swap on its bytes.
		const merge = lastMerge as Committed | null;
		if (answer.kind !== 'merged' || merge === null || merge.parents[1] !== commit.id) return;
		const from = chain.indexOf(commit.parent);
		const before = chain.indexOf(merge.parents[0] ?? '');
		for (const file of commit.files) {
			if (file.text === null || from < 0 || before < 0) continue;
			const then = states.get(commit.parent)?.get(file.path) ?? null;
			const ours = states.get(chain[before] ?? '')?.get(file.path) ?? null;
			// A blob never merges: it lands by compare-and-swap over the bytes its writer saw (a path deleted and made again with those bytes holds them).
			if (!file.path.endsWith('.md')) {
				// What its writer saw: `over` when it said, else the commit's parent. One that lost lands beside it.
				const saw = file.over !== undefined ? file.over : then;
				const landed = states.get(merge.id)?.get(file.path) === file.text;
				if (landed && ours !== saw && ours !== file.text) violations.push(`server: ${device}'s write of ${file.path} landed over bytes it had not seen`);
				continue;
			}
			let deleted = false;
			for (let i = from + 1; i <= before; i++) if (!states.get(chain[i] ?? '')?.has(file.path)) deleted = true;
			// Two creates of the same text (two notes from the template) are one text: nothing to keep apart.
			const other = ours !== null && ours !== file.text && (then === null || deleted);
			const after = states.get(merge.id)?.get(file.path) ?? '';
			// Inside a block, delimiter-like lines of the incoming note are escaped.
			if (other && !(after.includes('<<<<<<< ') && after.includes(escapeLines(file.text.trimEnd()))))
				violations.push(`server: ${device}'s edit of ${file.path} merged silently into another note (${then === null ? 'two creates' : 'deleted since its parent'})`);
		}
	});

	/** A person saves texts. `seen` is what their editor showed (default: what the device shows now). */
	const save = (d: Device, changes: Record<string, string | null>, typed: string[], seen?: Record<string, string | null>, { editor = seen !== undefined } = {}) => {
		const paths = Object.keys(changes);
		const showed = (path: string) => (seen === undefined ? d.replica.read(path) : (seen[path] ?? null));
		const before = counts(paths.map(showed));
		const written = counts(Object.values(changes));
		for (const [t, n] of before) if ((written.get(t) ?? 0) < n) removed.add(t);
		for (const t of typed) if (written.has(t)) owed.set(t, d.name);
		for (const [path, text] of Object.entries(changes)) {
			for (const a of attaches) if (a.device === d.name && a.path === path && a.text !== text) a.settled = true;
			for (const r of removals) if (r.device === d.name && r.path === path && text !== null) r.cancelled = true;
			// A removal claims a note the device had from the server, not one it created and never sent,
			const known = d.replica.files().get(path)?.base ?? null;
			// A blob's delete removes what it deletes over: the device's own unsent bytes, if it shows them (a write that may have lost, which the delete then withdraws), else main's.
			const blobOverOwn = !path.endsWith('.md') && showed(path) !== known;
			if (text === null && showed(path) !== null && known !== null && !blobOverOwn)
				removals.push({
					device: d.name,
					path,
					base: known,
					position: d.replica.position(),
					at: chain.length,
					landed: world.server.read(path) === null,
					cancelled: false,
					step: log.at(-1) ?? '',
				});
		}
		d.replica.writeAll(changes, editor && seen !== undefined ? { over: seen } : {});
	};

	const serverText = () => [...world.server.snapshot().values()].join('\n');
	const deviceText = () => everyone.flatMap((d) => [...d.replica.files().values()].map((f) => f.mine ?? '')).join('\n');
	/** Every device's files, their state and position, and the server's main, for a traced failure. */
	const dump = () =>
		[
			`server main ${world.server.main()}`,
			...everyone.map((d) =>
				[
					`${d.name} at ${d.replica.position()}${d.replica.busy() ? ' (busy)' : ''}`,
					...[...d.replica.files()].map(
						([path, f]) =>
							`  ${path} ${JSON.stringify(d.replica.state(path))}${f.settled ? '' : ' unsettled'}\n    base ${JSON.stringify(f.base?.slice(0, 300))}\n    mine ${JSON.stringify(f.mine?.slice(0, 300))}\n    tip  ${JSON.stringify(f.tip?.slice(0, 300))}`,
					),
				].join('\n'),
			),
		].join('\n');
	/** What devices have not sent and made themselves: the tokens each shows at a path it has not sent (held, or sending) that its base there does not hold. */
	const unsentText = (devices = everyone) =>
		devices
			.flatMap((d) => {
				const files = d.replica.files();
				return d.replica.unsent().flatMap((path) => {
					const base = tokensIn(files.get(path)?.base ?? null);
					return [...tokensIn(d.replica.read(path))].filter((t) => !base.has(t));
				});
			})
			.join('\n');
	const check = (step: string, quiet: boolean) => {
		const server = serverText();
		const devices = quiet ? '' : deviceText();
		const unsent = quiet ? '' : unsentText();
		// RULE: each file goes on its own, so a person's rename whose new file cannot go yet (held: it does not parse, say) deletes the old one from the server while the text waits in the new file, on their device; once it can go, it is sent.
		for (const t of acknowledged)
			if (!removed.has(t) && !forgotten.has(t) && owed.has(t) && !server.includes(t) && !unsent.includes(t)) violations.push(`${step}: acknowledged ${t} (${owed.get(t)}) is in no server text and no unsent file`);
		for (const [t, who] of owed)
			if (!removed.has(t) && !forgotten.has(t) && !server.includes(t) && (quiet || !devices.includes(t))) violations.push(`${step}: lost ${t} (${who})`);
		if (violations.length > 0) throw new Error(`seed ${seed}\n${[...new Set(violations)].join('\n')}\n--- steps\n${log.join('\n')}${tracing ? `\n--- devices\n${dump()}` : ''}`);
	};

	/** An editor buffer each person opened and has not saved yet. */
	const editors = new Map<string, { path: string; text: string }>();

	// A hostile member writing straight to the server, and a stranger.
	const hostile = (member: string, files: LiveCommit['files'], { author = member, parent = world.server.main(), id }: { author?: string; parent?: string; id?: string } = {}) => {
		const body = { parent, author: { user: author, device: 'x' }, time: STAMP, files };
		const commit = { id: id ?? commitId(body), ...body };
		return world.server.push(commit, world.session(member));
	};
	const accepted = (answer: PushAnswer) => answer.kind === 'applied' || answer.kind === 'merged';
	const hostileSteps: (() => string)[] = [
		() => {
			if (accepted(hostile('mallory', [{ path: random.pick(PATHS), text: '---\ntitle: forged\n---\nforged\n' }], { author: 'alice' })))
				violations.push('server: accepted a commit whose author is not the session');
			return 'mallory forges alice as author';
		},
		() => {
			if (accepted(hostile('eve', [{ path: 'notes/eve.md', text: '---\ntitle: eve\n---\n' }]))) violations.push('server: accepted a commit from a non-member');
			return 'eve, not a member, pushes';
		},
		() => {
			if (accepted(hostile('mallory', [{ path: 'notes/m.md', text: `---\ntitle: m\n---\n${FILLER}\n` }]))) violations.push('server: accepted a note larger than 1 MB');
			return 'mallory pushes an oversized note';
		},
		() => {
			if (accepted(hostile('mallory', [{ path: 'notes/m.md', text: '---\r\ntitle: M\r\n---\r\nm\r\n' }]))) violations.push('server: accepted a note with CRLF endings');
			return 'mallory pushes a note with CRLF endings';
		},
		() => {
			// Appended to what is there, so it removes nothing a person typed.
			const path = random.pick(PATHS);
			const text = world.server.read(path) ?? '---\ntitle: forged\n---\n';
			hostile('mallory', [{ path, text: `${text}${text.endsWith('\n') ? '' : '\n'}<<<<<<< main (alice/laptop)\nI approve\n||||||| base\n=======\nI do not\n>>>>>>> bob/phone\n` }]);
			return 'mallory writes forged conflict labels';
		},
		() => {
			const id = honestIds.length === 0 ? undefined : random.pick(honestIds);
			if (id !== undefined && accepted(hostile('mallory', [{ path: random.pick(PATHS), text: '---\ntitle: replay\n---\nreplayed\n' }], { id })))
				violations.push('server: a replayed id with other files was accepted');
			return 'mallory replays an id with other files';
		},
		() => {
			const path = random.pick(PATHS);
			let landed = 0;
			for (let i = 0; i < FLOOD; i++)
				if (accepted(hostile('mallory', [{ path, text: `---\ntitle: flood\n---\nflood ${i}\n` }], { parent: chain[0] ?? '' }))) landed++;
			if (landed > FLOOD_BOUND) violations.push(`server: ${landed} of a flood of ${FLOOD} stale-parent commits were accepted`);
			return `mallory floods ${path} with stale-parent commits`;
		},
	];

	/** The upload track's word that bytes are present, which comes only once the server holds them. */
	const hear = (d: Device, bytes: { oid: string; size: number }) => {
		d.replica.present(bytes.oid, bytes.size);
		let set = marked.get(d.name);
		if (set === undefined) marked.set(d.name, (set = new Set()));
		set.add(bytes.oid);
	};
	const owedBy = (d: Device) => d.replica.owed();
	/** One of `d`'s owed bytes, or undefined when it owes none. */
	const someOwed = (d: Device) => {
		const owing = owedBy(d);
		return owing.length === 0 ? undefined : random.pick(owing);
	};

	const blobSteps: [number, (d: Device) => string | null | Promise<string | null>][] = [
		// Attach bytes at a named path (a create or a replace), sometimes with a note naming it, saved together.
		[
			3,
			(d) => {
				const path = random.pick(BLOB_PATHS);
				const text = writePointer(random.pick(BYTES));
				if (d.replica.read(path) === text) return null;
				const changes: Record<string, string | null> = { [path]: text };
				const typed: string[] = [];
				const notePath = random.pick(PATHS);
				const noteText = d.replica.read(notePath);
				if (random.chance(0.5) && noteText !== null) {
					const t = token();
					typed.push(t);
					changes[notePath] = `${noteText}${noteText.endsWith('\n') ? '' : '\n'}audio ${path} ${t}\n`;
				}
				save(d, changes, typed);
				attaches.push({ device: d.name, path, text, settled: false });
				return `${d.name} attaches ${parsePointer(text)?.oid.slice(0, 1)} at ${path}${typed.length > 0 ? ` with ${notePath} (${typed[0]})` : ''}`;
			},
		],
		[
			1,
			(d) => {
				const path = random.pick(BLOB_PATHS);
				if (d.replica.read(path) === null) return null;
				save(d, { [path]: null }, []);
				return `${d.name} deletes ${path}`;
			},
		],
		// Replace a blob `main` has, change back to `main`'s bytes, and replace it again with bytes not yet present, in three calls before any answer: `main`'s bytes, saved over the first replace in flight, are new again, and the last save sits over them (seeds 470249, 470282).
		[
			1,
			(d) => {
				const path = random.pick(BLOB_PATHS);
				const base = d.replica.files().get(path)?.base ?? null;
				const unmarked = (text: string) => !marked.get(d.name)?.has(parsePointer(text)?.oid ?? '');
				if (base === null || d.replica.read(path) !== base || !unmarked(base)) return null;
				const others = BYTES.map(writePointer).filter((text) => text !== base);
				const pending = others.filter(unmarked);
				if (pending.length === 0) return null;
				const [first, last] = [random.pick(others), random.pick(pending)];
				for (const text of [first, base, last]) save(d, { [path]: text }, []);
				attaches.push({ device: d.name, path, text: last, settled: false });
				const short = (text: string) => parsePointer(text)?.oid.slice(0, 1);
				return `${d.name} replaces ${path} with ${short(first)}, back to ${short(base)}, then ${short(last)}`;
			},
		],
		// The upload track, out of order: the server receives bytes; a device hears they are present (only once the server has them); an upload fails and will retry; an upload is refused.
		[
			2,
			() => {
				const bytes = random.pick(BYTES);
				if (refusedBytes.has(bytes.oid) || world.server.uploaded(bytes.oid) !== null) return null;
				world.server.upload(bytes.oid, bytes.size);
				return `the server receives ${bytes.oid.slice(0, 1)}`;
			},
		],
		[
			2,
			(d) => {
				const bytes = someOwed(d);
				if (bytes === undefined || world.server.uploaded(bytes.oid) !== bytes.size) return null;
				hear(d, bytes);
				return `${d.name} hears ${bytes.oid.slice(0, 1)} is present`;
			},
		],
		[1, (d) => (owedBy(d).length === 0 ? null : `${d.name}'s upload fails; it will retry`)],
		[
			1,
			(d) => {
				const bytes = someOwed(d);
				if (bytes === undefined || world.server.uploaded(bytes.oid) !== null) return null;
				refusedBytes.add(bytes.oid);
				d.replica.refused(bytes.oid, REFUSED);
				return `${d.name}'s upload of ${bytes.oid.slice(0, 1)} is refused`;
			},
		],
	];

	const steps: [number, (d: Device) => string | null | Promise<string | null>][] = [
		...blobSteps,
		// Type a word into the body, or create the note.
		[
			6,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				const t = token();
				if (text === null) {
					save(d, { [path]: `---\ntitle: ${t}\n---\n` }, [t]);
					return `${d.name} creates ${path} (${t})`;
				}
				const { bodyStart } = splitMarkdown(text);
				const lines = text.slice(bodyStart).split('\n');
				const at = random.int(0, lines.length - 1);
				// A person types words on a line of text, never onto a conflict block's delimiter line (which would end the block, so its sides read as plain text).
				const delimiter = /^\\*(<<<<<<<|\|{7}|={7}|>>>>>>>)/.test(lines[at] ?? '');
				if (random.chance(0.5) && !delimiter) lines.splice(at, 1, `${lines[at] ?? ''} ${t}`.trim());
				else lines.splice(at, 0, t);
				save(d, { [path]: text.slice(0, bodyStart) + lines.join('\n') }, [t]);
				return `${d.name} types ${t} in ${path}`;
			},
		],
		// Set one field, which several devices set.
		[
			3,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null) return null;
				const t = token();
				save(d, { [path]: writeMarkdown(text, { fields: { mood: t } }) }, [t]);
				return `${d.name} sets mood ${t} in ${path}`;
			},
		],
		// Open an editor on a note, or save the one opened earlier with a word typed: the buffer may be stale.
		[
			2,
			(d) => {
				const open = editors.get(d.name);
				if (open === undefined) {
					const path = random.pick(PATHS);
					const text = d.replica.read(path);
					if (text === null) return null;
					editors.set(d.name, { path, text });
					return `${d.name} opens an editor on ${path}`;
				}
				editors.delete(d.name);
				const t = token();
				save(d, { [open.path]: `${open.text}${open.text.endsWith('\n') ? '' : '\n'}${t}\n` }, [t], { [open.path]: open.text });
				return `${d.name} saves an editor buffer on ${open.path} with ${t}`;
			},
		],
		// Break the frontmatter with a quote left open.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || !text.startsWith('---\n') || !opensParsed(text)) return null;
				const t = token();
				save(d, { [path]: `---\nx${t}: "open\n${text.slice(4)}` }, [t]);
				return `${d.name} breaks ${path} (${t})`;
			},
		],
		// Paste far too much into a note.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || hasFiller(text)) return null;
				const t = token();
				save(d, { [path]: `${text}${text.endsWith('\n') ? '' : '\n'}${t} ${FILLER}\n` }, [t]);
				return `${d.name} pastes more than 1 MB into ${path} (${t})`;
			},
		],
		// Repair frontmatter that does not parse, or a note that does not fit.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				if (text === null || (opensParsed(text) && !hasFiller(text))) return null;
				save(d, { [path]: repair(text) }, []);
				return `${d.name} repairs ${path}`;
			},
		],
		// Delete a word.
		[
			2,
			(d) => {
				const path = random.pick(PATHS);
				const text = d.replica.read(path);
				const words = [...tokensIn(text)];
				if (text === null || words.length === 0) return null;
				const word = random.pick(words);
				save(d, { [path]: text.replace(new RegExp(` ?${word}`), '') }, []);
				return `${d.name} deletes the word ${word} in ${path}`;
			},
		],
		// Rename: delete the old path and write the new one, in one write.
		[
			1,
			(d) => {
				const from = random.pick(PATHS);
				const to = random.pick(PATHS);
				const text = d.replica.read(from);
				if (text === null || from === to || d.replica.read(to) !== null) return null;
				save(d, { [from]: null, [to]: text }, []);
				return `${d.name} renames ${from} to ${to}`;
			},
		],
		// Delete a note.
		[
			1,
			(d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				save(d, { [path]: null }, []);
				return `${d.name} deletes ${path}`;
			},
		],
		// Delete a note and create its path again at once, often from the template.
		[
			1,
			async (d) => {
				const path = random.pick(PATHS);
				if (d.replica.read(path) === null) return null;
				save(d, { [path]: null }, []);
				await world.runFor(random.int(0, 400));
				if (d.replica.read(path) !== null) return `${d.name} deletes ${path}, which came back`;
				const t = token();
				const fresh = random.chance(0.5) ? TEMPLATE : `---\ntitle: ${t}\n---\n`;
				save(d, { [path]: fresh }, [t]);
				return `${d.name} deletes and re-creates ${path}${fresh === TEMPLATE ? ' from the template' : ` (${t})`}`;
			},
		],
		[1, (d) => (d.setOnline(!d.isOnline()), `${d.name} goes ${d.isOnline() ? 'online' : 'offline'}`)],
		[1, (d) => (d.loseNextReply(), `${d.name} will lose its next reply`)],
		[1, (d) => (d.restart(), `${d.name} restarts`)],
		[1, () => (world.flush(), 'the server flushes')],
		// Nobody pushes for longer than the retention window: positions and answers older than it are pruned.
		[
			1,
			async () => {
				const ms = LIMITS.window + random.int(0, 120_000);
				await world.runFor(ms);
				return `the repository is idle for ${ms} ms`;
			},
		],
		[
			1,
			async (d) => {
				d.loseNextReply();
				await world.runFor(random.int(50, 400));
				world.flush();
				return `${d.name} loses a reply, and the server flushes`;
			},
		],
		// The device's storage is lost for good: what it never had acknowledged is gone with it.
		[
			1,
			(d) => {
				for (const [t, who] of owed) if (who === d.name && !acknowledged.has(t)) forgotten.add(t);
				// Acknowledged text this device moved into a file it has not sent (a rename whose new file was held), which neither the server nor another device's unsent work has, goes with it.
				const server = serverText();
				const others = unsentText(everyone.filter((other) => other !== d));
				for (const t of tokensIn(unsentText([d]))) if (acknowledged.has(t) && !server.includes(t) && !others.includes(t) && !forgotten.has(t)) {
					forgotten.add(t);
					lostWithUnsent++;
				}
				for (const r of removals) if (r.device === d.name && !r.landed) r.cancelled = true;
				for (const a of attaches) if (a.device === d.name) a.settled = true;
				marked.delete(d.name);
				editors.delete(d.name);
				d.lose();
				return `${d.name} loses its storage`;
			},
		],
		[1, () => random.pick(hostileSteps)()],
	];
	const total = steps.reduce((sum, [weight]) => sum + weight, 0);

	/** The agent: a writer whose step saves several notes at once (one transaction, each file going on its own), through the same replica and merge rule as everyone. */
	const agentBatch = () => {
		const picked = PATHS.filter(() => random.chance(0.5));
		const paths = picked.length === 0 ? [random.pick(PATHS)] : picked;
		const changes: Record<string, string | null> = {};
		const typed: string[] = [];
		for (const path of paths) {
			const t = token();
			typed.push(t);
			const text = agent.replica.read(path);
			changes[path] = text === null ? `---\ntitle: ${t}\n---\n` : `${text}${text.endsWith('\n') ? '' : '\n'}agent ${t}\n`;
		}
		// Sometimes with new bytes, named by the first note.
		const blobPath = random.pick(BLOB_PATHS);
		const pointer = writePointer(random.pick(BYTES));
		const withBlob = random.chance(0.35) && agent.replica.read(blobPath) !== pointer;
		// Bytes the server has there before this batch, as the agent knows it (its commit in flight there, else its base): the write sends nothing, so the batch owes no blob.
		const flying = agent.replica.sent()?.files.find((file) => file.path === blobPath);
		const sends = (flying === undefined ? agent.replica.files().get(blobPath)?.base : flying.text) !== pointer;
		const first = paths[0] as string;
		if (withBlob) {
			changes[blobPath] = pointer;
			changes[first] = `${changes[first]}audio ${blobPath}\n`;
		}
		save(agent, changes, typed);
		const blob = withBlob ? { device: agent.name, path: blobPath, text: pointer, settled: !sends } : undefined;
		if (blob !== undefined) attaches.push(blob);
		return `agent saves ${paths.map((path, i) => `${typed[i]} in ${path}`).join(', ')}${blob === undefined ? '' : ` and ${parsePointer(pointer)?.oid.slice(0, 1)} at ${blobPath}`} at once`;
	};
	/** The upload track's steps that act on one device (hearing bytes are present, a failed or refused upload), for the agent too. */
	const trackSteps = blobSteps.slice(4);
	const agentSteps: [number, () => string | null | Promise<string | null>][] = [
		[6, agentBatch],
		...trackSteps.map(([weight, act]): [number, () => string | null | Promise<string | null>] => [weight, () => act(agent)]),
		[1, () => (agent.setOnline(!agent.isOnline()), `agent goes ${agent.isOnline() ? 'online' : 'offline'}`)],
		[1, () => (agent.loseNextReply(), 'agent will lose its next reply')],
		[1, () => (agent.restart(), 'agent restarts')],
	];
	const agentStep = async () => {
		let pick = random.int(1, agentSteps.reduce((sum, [weight]) => sum + weight, 0));
		for (const [weight, act] of agentSteps) {
			pick -= weight;
			if (pick <= 0) return await act();
		}
		return null;
	};

	for (let n = 0; n < STEPS; n++) {
		let said: string | null = null;
		if (random.chance(0.12)) said = await agentStep();
		else {
			let pick = random.int(1, total);
			const d = random.pick(people);
			for (const [weight, act] of steps) {
				pick -= weight;
				if (pick <= 0) {
					said = await act(d);
					break;
				}
			}
		}
		if (said !== null) log.push(`${world.now()} ${n}: ${said}`);
		await world.runFor(random.int(0, 300));
		check(`after step ${n}`, false);
	}

	// Quiescence: everyone online; each person repairs what does not fit, and saves what they hold. A note whose frontmatter does not parse syncs as it is.
	world.calm();
	for (const d of everyone) d.setOnline(true);
	for (let round = 0; round < 6; round++) {
		// Every upload completes, or is refused.
		for (const d of everyone)
			for (const bytes of owedBy(d)) {
				if (refusedBytes.has(bytes.oid)) {
					d.replica.refused(bytes.oid, REFUSED);
					continue;
				}
				if (world.server.uploaded(bytes.oid) === null) world.server.upload(bytes.oid, bytes.size);
				hear(d, bytes);
			}
		if (!(await world.settle())) throw new Error(`seed ${seed}: never went idle\n${log.join('\n')}`);
		// Held alone: with everyone online and every upload done or refused, what a device has not sent waits or is refused, each file with a reason of its own (none still uploading); nothing waits on another file.
		for (const d of everyone) {
			const held = new Map(d.replica.notSent().filter((h) => h.reason !== UPLOADING).map((h) => [h.path, h.reason]));
			for (const [path, reason] of held) if (reason.trim() === '') violations.push(`quiet: ${d.name} holds ${path} with no reason`);
			for (const path of d.replica.unsent()) if (!held.has(path)) violations.push(`quiet: ${d.name}'s ${path} is not sent and not held (${JSON.stringify(d.replica.state(path))})`);
		}
		let saved = false;
		for (const d of everyone) {
			const held = new Map(d.replica.notSent().map((h) => [h.path, h.reason]));
			for (const path of new Set([...d.replica.paths(), ...held.keys()])) {
				const text = d.replica.read(path);
				const reason = held.get(path);
				if (text === null) continue;
				if (!path.endsWith('.md')) {
					// A held blob (refused, or written over one that moved): its person discards it, keeping what the server has.
					if (reason === undefined) continue;
					for (const a of attaches) if (a.device === d.name && a.path === path && a.text === text) a.settled = true;
					save(d, { [path]: d.replica.files().get(path)?.base ?? null }, []);
					log.push(`quiet: ${d.name} discards ${path} (${reason})`);
					saved = true;
					continue;
				}
				// Too many blocks: the person resolves them by keeping every side's lines, which removes nothing typed.
				const unblocked = reason === REASONS['too-many-blocks'] ? text.split('\n').filter((line) => !/^(<<<<<<< |\|\|\|\|\|\|\| base$|=======$|>>>>>>> )/.test(line)).join('\n') : text;
				if (unblocked !== text) for (const t of tokensIn(text)) retyped.add(t);
				const fixed = hasFiller(unblocked) ? repair(unblocked) : unblocked;
				if (fixed === text && text === world.server.read(path) && reason === undefined) continue;
				save(d, { [path]: fixed }, []);
				log.push(`quiet: ${d.name} saves ${path}${reason === undefined ? '' : ` (${reason})`}`);
				saved = true;
			}
		}
		if (!saved) break;
	}
	await world.settle();
	check('at quiescence', true);
	const server = world.server.snapshot();
	for (const d of everyone) {
		if (d.replica.busy()) violations.push(`quiet: ${d.name} is still busy`);
		const files = d.replica.files();
		for (const path of new Set([...server.keys(), ...files.keys()])) {
			const file = files.get(path);
			const want = server.get(path) ?? null;
			if ((file !== undefined && !file.settled) || (file?.mine ?? null) !== want || (file?.base ?? null) !== want)
				violations.push(
					`quiet: ${d.name} ${path}: mine ${JSON.stringify(file?.mine?.slice(0, 200))} base ${JSON.stringify(file?.base?.slice(0, 200))} server ${JSON.stringify(want?.slice(0, 200))}`,
				);
		}
	}
	// A removal stays removed, unless it lost to an edit by someone else made after the text it removed (which it had not seen).
	const lostToEdit = (r: (typeof removals)[number]) => {
		// Everything after the remover's position is unseen by it; the text alone cannot say where that is, since an edit can bring a path back to the text it had.
		let from = r.position === null ? -1 : chain.indexOf(r.position);
		if (from < 0) for (from = r.at - 1; from > 0 && (states.get(chain[from] ?? '')?.get(r.path) ?? null) !== r.base; ) from--;
		return writers.slice(from + 1).some((w) => w.user !== r.device && w.paths.has(r.path));
	};
	// An attach that lost landed beside its path, at a sibling named from its bytes.
	const landedAt = (a: (typeof attaches)[number]) => {
		const oid = parsePointer(a.text)?.oid ?? '';
		return [a.path, ...Array.from({ length: 58 }, (_, n) => conflictSibling(a.path, oid, n + 7))].some((at) => onMain.has(`${at}\0${a.text}`));
	};
	for (const a of attaches) if (!a.settled && !landedAt(a)) violations.push(`quiet: ${a.device}'s attach at ${a.path} never landed`);
	for (const r of removals)
		if (!r.cancelled && !r.landed && server.has(r.path) && !lostToEdit(r))
			violations.push(`quiet: ${r.device}'s removal of ${r.path} (${r.step}) never took effect, and no edit it had not seen beat it`);
	// None applied twice.
	for (const [path, text] of server) {
		if (text === null || !path.endsWith('.md')) continue;
		for (const [version, written] of versionsOf(text)) {
			const seen = new Map<string, number>();
			for (const t of written.match(TOKEN) ?? []) seen.set(t, (seen.get(t) ?? 0) + 1);
			for (const [t, n] of seen) if (n > 1 && !retyped.has(t)) violations.push(`quiet: ${t} appears ${n} times in ${path} (${version})`);
		}
	}
	check('at quiescence', true);
	const notices: Record<string, number> = {};
	for (const line of log) {
		const reason = /^quiet: \w+ (?:saves|discards) \S+ \(([^)]+)\)/.exec(line)?.[1];
		if (reason === undefined) continue;
		const key = `held: ${reason}`;
		notices[key] = (notices[key] ?? 0) + 1;
	}
	const stats: Record<string, number> = {};
	for (const d of everyone) for (const [key, value] of Object.entries(d.replica.stats())) stats[key] = (stats[key] ?? 0) + value;
	const conflicts = [...server.values()].filter((text) => text?.includes('<<<<<<< ')).length;
	return { world, requests: world.counts(), notices, stats, conflicts, agentRefusals: agent.replica.stats().refused, lostWithUnsent };
}

/**
 * Register one test per seed: the run, then, once the last flush is done,
 * Git's main equals the server's main. `prefix` names the suite's
 * environment variables; `runs` is its default number of seeds.
 */
export function definePropertySuite({
	label,
	prefix,
	runs,
	world: makeWorld,
	timeout,
}: {
	label: string;
	prefix: string;
	runs: number;
	world: (options: WorldOptions) => PropertyWorld | Promise<PropertyWorld>;
	timeout?: number;
}) {
	const env = (name: string) => process.env[`${prefix}_${name}`];
	const count = Number(env('RUNS') ?? runs);
	const from = Number(env('FROM') ?? 1);
	const seeds = env('SEED') === undefined ? Array.from({ length: count }, (_, i) => from + i) : [Number(env('SEED'))];
	const steps = Number(env('STEPS') ?? 60);
	const totals: Record<string, number> = {};
	const add = (key: string, n: number) => {
		totals[key] = (totals[key] ?? 0) + n;
	};

	for (const seed of seeds)
		test(
			`${label} keeps every invariant under seed ${seed}`,
			async () => {
				let opened: PropertyWorld | undefined;
				try {
					const result = await run(seed, async (options) => (opened = await makeWorld(options)), steps);
					const { world } = result;
					expect(result.requests.push).toBeGreaterThan(0);
					// Flushes ran on their schedule during the run; once the last is done, Git's main is the server's main.
					await world.server.idle();
					await world.flush();
					const head = await world.git.readRef(MAIN);
					const tree = head === null ? new Map() : await world.git.readTree((await world.git.readCommit(head))?.tree ?? '');
					const decoder = new TextDecoder();
					const inGit = new Map<string, string>();
					for (const [path, entry] of tree) if (path !== '.gitattributes') inGit.set(path, decoder.decode((await world.git.readBlob(entry.oid)) ?? new Uint8Array()));
					expect(inGit).toEqual(world.server.snapshot());
					for (const [key, n] of Object.entries({ ...result.requests, ...result.stats })) add(key, n);
					for (const [kind, n] of Object.entries(result.notices)) add(`notice:${kind}`, n);
					add('conflicted files', result.conflicts);
					add('agent refusals', result.agentRefusals);
					add('acknowledged lost with a device\'s unsent work', result.lostWithUnsent);
				} finally {
					await opened?.close();
				}
			},
			timeout,
		);

	if (env('TOTALS') !== undefined) test(`${label}: totals`, () => console.log(totals));
}
