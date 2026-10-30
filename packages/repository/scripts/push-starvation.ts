/**
 * Push Starvation: does a `git push` ever land while people autosave?
 *
 * Measures the receive path as built (receive.ts, flush.ts, server.ts). At
 * d1feeba6b7 `receive` refused a push as `unflushed` while live history ran
 * ahead of Git, or when a live commit landed during its asynchronous Git
 * checks. Under push-as-merge (as built since phase 9d) it takes any push
 * whose old value is Git's `main` and merges it into live `main`; the only
 * refusal left that typing can cause is `main-moved` (a flush moved Git's
 * `main` between fetch and push). A flush writes its objects as one pack
 * with its staging ref (`writePack`, one receive-pack request), so it costs
 * one Git call here however many commits it writes, and a push waiting
 * behind it waits a few calls. After each run the script flushes and
 * checks that every landed push is in Git's history and that Git's `main`
 * holds the live tree.
 *
 * Everything runs in virtual time on one timer queue: the server's clock and
 * its alarm (the real schedule, 60 s quiet, at most 5 min busy), a latency on
 * every Git call the server makes (Artifacts in production), N people each
 * autosaving one note every 1 to 3 s (uniform) with prose edits, and one
 * pusher that, every 3 to 8 s after its last push landed, fetches Git's
 * `main`, rebases one commit (a line appended to `agent/log.md`) onto it,
 * uploads it and calls `receive`, retrying the same commit until it lands.
 * The server's work is synchronous SQLite plus promise-only memory Git, so
 * draining one `setImmediate` per timer runs each step to completion.
 *
 * Pusher strategies (all on unmodified server code):
 * - `retry`: a plain Git client. On any refusal, wait 1 s, fetch, rebase, push.
 * - `wait-flush`: on a refusal, wait until any flush in progress has
 *   finished, then fetch, rebase and push at once.
 * - `fetch-flush`: every fetch asks the server to flush first (`server.flush`,
 *   as `git fetch` may, ADR-0692), then reads Git's `main`; refusal retries at once.
 *
 * Typing patterns: `steady` (everyone saves every 1 to 3 s throughout) and
 * `bursty` (each person types for a while, mean 60 s, then pauses, mean
 * 120 s, so is typing a third of the time).
 *
 * Latency profiles: `instant` (no latency at all, the bound), `fast` (Git call 5 ms, fetch 100 ms, upload 100 ms),
 * `typical` (20, 400, 400), `slow` (50, 1000, 1000). Fetch and upload are
 * client round trips; the fetch reads the ref halfway through, the upload
 * reaches `receive` at its end, and the answer takes half a fetch to return.
 *
 * Refusal causes:
 * - `pending` and `landed` (d1feeba6b7 only): `unflushed` at the start of
 *   `receive`, or because a save landed during the push's Git checks
 * - `main-moved`: a flush moved Git's `main` between fetch and push
 *
 * "Git commits written" counts rows in the server's `flushes` table: one per
 * Git commit a flush wrote, and one per accepted push.
 *
 * Run: bun scripts/push-starvation.ts [minutes=20] [seeds=3] [people=0,1,10] [strategies=retry,wait-flush,fetch-flush] [profiles=instant,fast,typical,slow] [patterns=steady,bursty]
 */
import { openBunSqlite } from '../src/bun/sqlite.js';
import { commitId, type LiveCommit } from '../src/core/commit.js';
import { ATTRIBUTES } from '../src/core/door.js';
import { type GitObjects, MAIN } from '../src/server/git-store.js';
import { createMemoryGitStore } from '../src/server/memory-git.js';
import {
	createServer,
	type Server,
	type Session,
} from '../src/server/server.js';

const minutes = Number(process.argv[2] ?? 20);
const seeds = Number(process.argv[3] ?? 3);
const peopleCounts = (process.argv[4] ?? '0,1,10').split(',').map(Number);
const strategies = (process.argv[5] ?? 'retry,wait-flush,fetch-flush').split(
	',',
) as Strategy[];
const profileNames = (process.argv[6] ?? 'instant,fast,typical,slow').split(
	',',
);
const patterns = (process.argv[7] ?? 'steady').split(',') as Pattern[];

type Strategy = 'retry' | 'wait-flush' | 'fetch-flush';
/** `steady`: everyone saves every 1 to 3 s throughout. `bursty`: each person types for a while (mean 60 s, saving every 1 to 3 s) and pauses (mean 120 s), so is typing a third of the time. */
type Pattern = 'steady' | 'bursty';
type Profile = { git: number; fetch: number; upload: number };
const PROFILES: Record<string, Profile> = {
	instant: { git: 0, fetch: 0, upload: 0 },
	fast: { git: 5, fetch: 100, upload: 100 },
	typical: { git: 20, fetch: 400, upload: 400 },
	slow: { git: 50, fetch: 1000, upload: 1000 },
};
const EPOCH = Date.UTC(2026, 9, 30, 9);
const BACKOFF = 1_000;

// ============================================================================
// Virtual time
// ============================================================================

function createVirtualTime() {
	let now = EPOCH;
	let seq = 0;
	const timers: { at: number; seq: number; fn: () => void }[] = [];
	function at(time: number, fn: () => void) {
		const timer = { at: Math.max(time, now), seq: seq++, fn };
		let low = 0;
		let high = timers.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			const other = timers[mid] as (typeof timers)[number];
			if (
				other.at < timer.at ||
				(other.at === timer.at && other.seq < timer.seq)
			)
				low = mid + 1;
			else high = mid;
		}
		timers.splice(low, 0, timer);
	}
	const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
	return {
		now: () => now,
		at,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => at(now + ms, resolve)),
		async run(until: number) {
			await drain();
			while (
				timers.length > 0 &&
				(timers[0] as (typeof timers)[number]).at <= until
			) {
				const timer = timers.shift() as (typeof timers)[number];
				now = timer.at;
				timer.fn();
				await drain();
			}
			now = until;
		},
	};
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ============================================================================
// People: prose autosaved every 1 to 3 s
// ============================================================================

const WORDS =
	'the a meeting notes project plan we should consider revisit draft budget timeline review feedback idea question answer because however also then next week today morning call with team about design launch customer research data model sync server note folder write read change keep small clear simple first second last open issue fix test ship'.split(
		' ',
	);

function createWriter(index: number, random: () => number) {
	const word = () => WORDS[Math.floor(random() * WORDS.length)] as string;
	const paragraphs = [`Notes from ${index}.`];
	return {
		path: `notes/person-${index}.md`,
		/** One autosave's worth of typing: a few words, sometimes a new paragraph or an edit mid-note. */
		edit() {
			const roll = random();
			if (roll < 0.1)
				paragraphs.push(`${word()[0]?.toUpperCase()}${word().slice(1)}`);
			else if (roll < 0.2 && paragraphs.length > 1) {
				const at = Math.floor(random() * (paragraphs.length - 1));
				paragraphs[at] = (paragraphs[at] as string).replace(/\b\w+\b/, word());
			}
			const words = Array.from(
				{ length: 3 + Math.floor(random() * 10) },
				word,
			).join(' ');
			paragraphs[paragraphs.length - 1] += ` ${words}`;
			if (random() < 0.15) paragraphs[paragraphs.length - 1] += '.';
			while (paragraphs.join('\n\n').length > 4_000) paragraphs.shift();
			return `---\ntitle: Person ${index}\n---\n${paragraphs.join('\n\n')}\n`;
		},
	};
}

// ============================================================================
// One run
// ============================================================================

type Attempt = {
	at: number;
	answer: 'accepted' | 'pending' | 'landed' | 'main-moved' | string;
	merged?: boolean;
	oid?: string;
};
type LogicalPush = {
	started: number;
	attempts: Attempt[];
	landed: number | null;
};

async function runOnce({
	people,
	strategy,
	profile,
	pattern,
	seed,
}: {
	people: number;
	strategy: Strategy;
	profile: Profile;
	pattern: Pattern;
	seed: number;
}) {
	const random = mulberry32(seed * 7919 + people * 31 + strategy.length);
	const exponential = (mean: number) => -mean * Math.log(1 - random());
	const vt = createVirtualTime();
	const raw = createMemoryGitStore();
	let readCommits = 0;
	// The server's Git: every call costs `profile.git` of virtual time.
	const slow =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			await vt.sleep(profile.git);
			return fn(...args);
		};
	const git: GitObjects = {
		readRef: slow(raw.readRef),
		readCommit: slow(async (oid: string) => {
			readCommits++;
			return raw.readCommit(oid);
		}),
		readTree: slow(raw.readTree),
		readBlob: slow(raw.readBlob),
		// One request, however many objects: a pack and its ref update.
		writePack: slow(raw.writePack),
		updateRef: slow(raw.updateRef),
		deleteRef: slow(raw.deleteRef),
	};
	const server: Server = createServer({
		store: openBunSqlite(),
		git,
		clock: vt.now,
		alarm: (due) => {
			let token = 0;
			return {
				schedule(at) {
					const mine = ++token;
					vt.at(at, () => {
						if (mine === token) due();
					});
				},
				cancel() {
					token++;
				},
			};
		},
	});
	const end = EPOCH + minutes * 60_000;
	const iso = () => new Date(vt.now()).toISOString();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	// Seed Git with a first flush, as a repository someone has used.
	const agentPath = 'agent/log.md';
	const agentSession: Session = { user: 'agent', role: 'writer' };
	{
		const body = {
			parent: server.main(),
			author: { user: 'agent', device: 'cli' },
			time: iso(),
			files: [
				{ path: agentPath, text: '---\ntitle: Agent log\n---\nStarted.\n' },
			],
		};
		server.push({ id: commitId(body), ...body }, agentSession);
	}
	const seeded = server.flush();
	await vt.run(EPOCH + 5_000);
	await seeded;

	let saves = 0;
	let saveRefusals = 0;
	for (let i = 0; i < people; i++) {
		const writer = createWriter(i, random);
		const session: Session = { user: `person-${i}`, role: 'writer' };
		let parent = server.main();
		let typingUntil =
			pattern === 'steady' || random() < 1 / 3
				? Number.POSITIVE_INFINITY
				: vt.now() - 1;
		if (pattern === 'bursty' && typingUntil === Number.POSITIVE_INFINITY)
			typingUntil = vt.now() + exponential(60_000);
		const save = () => {
			if (vt.now() >= end) return;
			if (vt.now() > typingUntil) {
				// A pause, then the next burst of typing.
				const resume = vt.now() + exponential(120_000);
				typingUntil = resume + exponential(60_000);
				vt.at(resume, () => {
					// Back from a pause on a replica that kept up with the change feed.
					parent = server.main();
					save();
				});
				return;
			}
			const body = {
				parent,
				author: { user: session.user, device: 'laptop' },
				time: iso(),
				files: [{ path: writer.path, text: writer.edit() }],
			};
			const commit: LiveCommit = { id: commitId(body), ...body };
			const answer = server.push(commit, session);
			if (answer.kind === 'applied' || answer.kind === 'merged') {
				parent = answer.main;
				saves++;
			} else saveRefusals++;
			vt.at(vt.now() + 1_000 + random() * 2_000, save);
		};
		vt.at(vt.now() + random() * 3_000, save);
	}

	// The pusher: one commit at a time, retried until it lands.
	const pushes: LogicalPush[] = [];
	let line = 0;
	async function attempt(lineText: string): Promise<Omit<Attempt, 'at'>> {
		if (strategy === 'fetch-flush') {
			await vt.sleep(profile.fetch / 2);
			await server.flush();
		} else await vt.sleep(profile.fetch / 2);
		const old = await raw.readRef(MAIN);
		await vt.sleep(profile.fetch / 2);
		// Rebase: the pusher's line on Git's main as fetched.
		const tree = await raw.readTree(
			(await raw.readCommit(old as string))?.tree as string,
		);
		const entry = tree.get(agentPath);
		const before =
			entry === undefined
				? '---\ntitle: Agent log\n---\n'
				: decoder.decode((await raw.readBlob(entry.oid)) ?? new Uint8Array());
		tree.set(agentPath, {
			mode: '100644',
			oid: await raw.writeBlob(encoder.encode(`${before}${lineText}\n`)),
		});
		const next = await raw.writeCommit({
			tree: await raw.writeTree(tree),
			parents: [old as string],
			message: `${lineText}\n`,
			author: { name: 'agent', email: 'agent@example.com' },
			at: new Date(vt.now()),
		});
		await vt.sleep(profile.upload);
		const reads = readCommits;
		const answer = await server.receive({ ref: MAIN, old, next }, agentSession);
		await vt.sleep(profile.fetch / 2);
		if (answer.kind === 'accepted')
			return { answer: 'accepted', merged: answer.merged, oid: next };
		if ((answer.code as string) === 'unflushed')
			return { answer: readCommits > reads ? 'landed' : 'pending' };
		return { answer: answer.code };
	}
	(async () => {
		while (vt.now() < end) {
			const push: LogicalPush = {
				started: vt.now(),
				attempts: [],
				landed: null,
			};
			pushes.push(push);
			const lineText = `Step ${++line} done.`;
			while (vt.now() < end) {
				const result = await attempt(lineText);
				const answer = result.answer;
				push.attempts.push({ at: vt.now(), ...result });
				if (answer === 'accepted') {
					push.landed = vt.now();
					break;
				}
				if (strategy === 'retry') await vt.sleep(BACKOFF);
				else if (
					strategy === 'wait-flush' &&
					(answer === 'pending' || answer === 'landed')
				)
					await server.idle();
			}
			if (push.landed === null) break;
			await vt.sleep(3_000 + random() * 5_000);
		}
	})();
	await vt.run(end);
	const flushes = server.history().flushes;
	// What was measured stops at `end`; an attempt still in flight may finish during the check below and is not counted.
	const measured = pushes.map((push) => ({
		...push,
		attempts: [...push.attempts],
	}));
	// History check: flush what is left, then every landed push is in Git's history and Git's main holds the live tree.
	const final = server.flush();
	await vt.run(end + 600_000);
	await final;
	const head = (await raw.readRef(MAIN)) as string;
	const reachable = new Set<string>();
	for (const stack = [head]; stack.length > 0; ) {
		const oid = stack.pop() as string;
		if (reachable.has(oid)) continue;
		reachable.add(oid);
		stack.push(...((await raw.readCommit(oid))?.parents ?? []));
	}
	const landedOids = pushes.flatMap((push) =>
		push.attempts
			.filter((a) => a.answer === 'accepted')
			.map((a) => a.oid as string),
	);
	const gitTexts = new Map<string, string>();
	for (const [path, entry] of await raw.readTree(
		(await raw.readCommit(head))?.tree as string,
	))
		gitTexts.set(
			path,
			decoder.decode((await raw.readBlob(entry.oid)) ?? new Uint8Array()),
		);
	const live = new Map([['.gitattributes', ATTRIBUTES], ...server.snapshot()]);
	const historyOk =
		landedOids.every((oid) => reachable.has(oid)) &&
		gitTexts.size === live.size &&
		[...live].every(([path, text]) => gitTexts.get(path) === text);
	return { pushes: measured, saves, saveRefusals, flushes, end, historyOk };
}

// ============================================================================
// Report
// ============================================================================

const quantile = (values: number[], q: number) => {
	if (values.length === 0) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.floor(q * sorted.length))
	] as number;
};
const s = (ms: number) =>
	Number.isNaN(ms) ? '-' : `${(ms / 1000).toFixed(1)}s`;

console.log(
	`push starvation: ${minutes} virtual minutes per run, ${seeds} seeds, schedule 60 s quiet / 5 min busy\n`,
);
console.log(
	'| people | pattern | strategy | profile | pushes landed | attempts | accepted/attempt | merged | retries to land p50/p90/max | time to land p50/p90/max | stuck at end (age) | refusals pending/landed/main-moved/other | saves | Git commits written | history ok |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const started = performance.now();
for (const people of peopleCounts)
	for (const pattern of patterns)
		for (const strategy of strategies)
			for (const name of profileNames) {
				const profile = PROFILES[name] as Profile;
				const all: LogicalPush[] = [];
				let saves = 0;
				let saveRefusals = 0;
				let flushes = 0;
				let historyOk = true;
				const ends: number[] = [];
				for (let seed = 1; seed <= seeds; seed++) {
					const run = await runOnce({
						people,
						strategy,
						profile,
						pattern,
						seed,
					});
					all.push(...run.pushes);
					saves += run.saves;
					saveRefusals += run.saveRefusals;
					flushes += run.flushes;
					historyOk &&= run.historyOk;
					ends.push(run.end);
				}
				const landed = all.filter((push) => push.landed !== null);
				const stuck = all.filter((push) => push.landed === null);
				const attempts = all.flatMap((push) => push.attempts);
				const count = (answer: string) =>
					attempts.filter((a) => a.answer === answer).length;
				const other = attempts.filter(
					(a) =>
						!['accepted', 'pending', 'landed', 'main-moved'].includes(a.answer),
				).length;
				const retries = landed.map((push) => push.attempts.length - 1);
				const times = landed.map(
					(push) => (push.landed as number) - push.started,
				);
				const end = ends[0] as number;
				const stuckAges = stuck.map((push) => end - push.started);
				console.log(
					`| ${people} | ${pattern} | ${strategy} | ${name} | ${landed.length}/${all.length} | ${attempts.length} | ${((100 * count('accepted')) / Math.max(1, attempts.length)).toFixed(1)}% | ${attempts.filter((a) => a.merged === true).length} | ${quantile(retries, 0.5)}/${quantile(retries, 0.9)}/${retries.length === 0 ? '-' : Math.max(...retries)} | ${s(quantile(times, 0.5))}/${s(quantile(times, 0.9))}/${s(times.length === 0 ? NaN : Math.max(...times))} | ${stuck.length}${stuck.length > 0 ? ` (${stuckAges.map((age) => s(age)).join(', ')})` : ''} | ${count('pending')}/${count('landed')}/${count('main-moved')}/${other} | ${saves}${saveRefusals > 0 ? ` (${saveRefusals} refused)` : ''} | ${flushes} | ${historyOk ? 'yes' : 'NO'} |`,
				);
			}
console.log(`\n(${((performance.now() - started) / 1000).toFixed(1)} s wall)`);
