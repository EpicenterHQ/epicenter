/**
 * Held Text Property Test
 *
 * A small pure model of one file's three levels (shown, promised, synced)
 * and the server, against the real engine driven through seeded random
 * sequences: Alice types whole texts, some of which break the frontmatter;
 * Bob edits, renames, deletes and reuses the path; Alice's pushes wait
 * until an acknowledgment releases them; Alice renames; Alice restarts.
 * After every step, the engine's levels must match the model, and no text
 * that fails the parse gate may have reached the server.
 *
 * The file keeps Alice's and Bob's changes apart, so every merge is clean
 * and the model can say exactly what each level holds: Alice changes the
 * title (breaking it by giving it twice), Bob changes the last body line,
 * as often as he likes, also while Alice's writes that show his earlier
 * edits wait: each of her writes starts from what she promised rebased
 * onto what she heard, so it never sends his edit back as hers.
 *
 * Set HELD_SEED to replay one sequence; a failure names its seed and steps.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './define.js';
import type { Transport } from './engine/ports.js';
import { parses } from './core/markdown.js';
import { merge } from './merge.js';
import type { Batch, Change } from './protocol.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './server/server.js';
import type { SqlDriver } from './sql.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) } });
const RUNS = 16;
const STEPS = 40;

// ----------------------------------------------------------------------------
// The model
// ----------------------------------------------------------------------------

/** Alice's part of the file: a title, given twice when she broke it. */
type Mine = { title: string; broken: boolean };
const render = ({ title, broken }: Mine, bob: string) => `---\ntitle: ${title}${broken ? `\ntitle: ${title}2` : ''}\n---\nalice\n.\n.\n${bob}\n`;

type Model = {
	/** Where Alice shows the file, or null when she shows none. */
	path: string | null;
	/** What Alice shows: her part and Bob's line as she last heard it, or a text the model knows only whole. */
	shown: { mine: Mine; bob: string; whole: string | null };
	held: boolean;
	/** The text of Alice's last queued change, or null when none is queued. */
	queued: string | null;
	/** Her part and Bob's line as of her last queued write, which lands on acknowledgment. */
	lands: { mine: Mine; bob: string } | null;
	/** The server's file. */
	server: { path: string; mine: Mine; bob: string } | null;
};
const shownText = (m: Model) => m.shown.whole ?? render(m.shown.mine, m.shown.bob);
const serverText = (m: Model) => (m.server === null ? null : render(m.server.mine, m.server.bob));
/**
 * The promised level: Alice's last queued part over Bob's line as she shows
 * it, since what she promised is rebased onto every change of Bob's she has
 * heard; else the server's text.
 */
const promisedText = (m: Model) => (m.queued === null || m.lands === null ? serverText(m) : render(m.lands.mine, m.shown.bob));

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ----------------------------------------------------------------------------
// The real engine
// ----------------------------------------------------------------------------

async function world() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-held-property-'));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	const pushed: Batch[] = [];
	let gate: Promise<void> | null = null;
	let open = () => {};
	const inner = createInProcessTransport(server, { user: 'alice' });
	const transport: Transport = {
		connect(handlers) {
			const link = inner.connect(handlers);
			return {
				...link,
				async push(batch) {
					pushed.push(structuredClone(batch));
					await gate;
					return link.push(batch);
				},
			};
		},
	};
	const file = join(dir, 'alice.sqlite');
	const openAlice = () => {
		const driver = openBunSqlite(file);
		return { driver, repo: openRepository({ app, driver, transport, device: 'alice' }) };
	};
	const bob = openRepository({ app, driver: openBunSqlite(), transport: createInProcessTransport(server, { user: 'bob' }), device: 'bob' });
	return {
		server,
		pushed,
		alice: openAlice(),
		bob,
		/** Alice's network, to lose a reply or come back online. */
		network: inner,
		openAlice,
		gated: () => gate !== null,
		hold() {
			gate = new Promise((resolve) => {
				open = resolve;
			});
		},
		release() {
			gate = null;
			open();
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/**
 * The engine's promised level at `path`, as it computes it from its outbox:
 * each queued person's change replayed onto the server's text as the device
 * last heard it.
 */
function enginePromised(driver: SqlDriver, path: string): string | null {
	const entries = driver
		.all<{ changes: string }>(`SELECT changes FROM "epicenter/outbox" WHERE policy = 'mark' AND outcome IS NULL ORDER BY n`)
		.flatMap((row) => JSON.parse(row.changes) as { change: Change; local: string | null }[]);
	const level = new Map<string, string | null>();
	const at = (where: string) =>
		level.has(where)
			? (level.get(where) ?? null)
			: (driver.all<{ synced: string | null }>('SELECT synced FROM "epicenter/files" WHERE path = ?', [where])[0]?.synced ?? null);
	for (const { change, local } of entries) {
		if (change.kind === 'move') {
			level.set(change.to, at(change.from));
			level.set(change.from, null);
			continue;
		}
		const below = at(change.path);
		if (change.kind === 'append') level.set(change.path, (below ?? '') + change.text);
		else if (change.base === null) level.set(change.path, below === null ? change.text : merge(null, below, change.text).text);
		else {
			const base = change.base.text ?? below;
			level.set(change.path, local === base ? below : merge(base, local, below).text);
		}
	}
	return at(path);
}

// ----------------------------------------------------------------------------
// One run
// ----------------------------------------------------------------------------

async function run(seed: number) {
	const random = rng(seed);
	const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)] as T;
	const w = await world();
	const log: string[] = [];
	const start: Mine = { title: 'A', broken: false };
	expectOk(await w.alice.repo.files.writeText('notes/a.md', render(start, 'b0')));
	await w.alice.repo.flush();
	await w.bob.flush();
	const m: Model = {
		path: 'notes/a.md',
		shown: { mine: start, bob: 'b0', whole: null },
		held: false,
		queued: null,
		lands: null,
		server: { path: 'notes/a.md', mine: start, bob: 'b0' },
	};
	let lastPath = 'notes/a.md';
	/** Alice lost a reply and is offline: only she acts until she reconnects. */
	let offline = false;
	let stems = 0;
	const freshPath = () => `notes/n${++stems}.md`;
	const stemOf = (path: string) => path.slice('notes/'.length, -'.md'.length);

	/** Let every step finish: Bob's work, and Alice's unless her pushes wait. */
	const settled = async () => {
		await w.bob.flush();
		if (w.gated()) await Bun.sleep(5);
		else await w.alice.repo.flush();
	};

	async function check() {
		const { repo, driver } = w.alice;
		const files = await repo.files.list();
		if (m.path === null) expect(files).toEqual([]);
		else {
			expect(files.map((file) => file.path)).toEqual([m.path]);
			expect(files[0]?.text).toBe(shownText(m));
			expect(files[0]?.sync.state).toBe(m.held ? 'held' : m.queued !== null ? 'sending' : 'synced');
			expect(enginePromised(driver, m.path)).toBe(promisedText(m));
			const synced = driver.all<{ synced: string | null }>('SELECT synced FROM "epicenter/files" WHERE path = ?', [m.path])[0]?.synced ?? null;
			// Offline after a lost reply, Alice has not heard that her batch landed.
			if (!offline) expect(synced).toBe(m.server?.path === m.path ? serverText(m) : null);
		}
		if (m.server !== null) expect(await w.server.read(m.server.path)).toBe(serverText(m));
		else expect(await w.server.read(lastPath)).toBeNull();
		for (const batch of w.pushed)
			for (const change of batch.changes) if (change.kind === 'write' && change.text !== null) expect(parses(change.text)).toBe(true);
	}

	const steps = {
		async type() {
			const mine: Mine = { title: pick(['A', 'B', 'C', 'D']), broken: random() < 0.4 };
			const path = m.path ?? lastPath;
			const bob = m.shown.whole !== null && m.server !== null ? m.server.bob : m.shown.bob;
			const text = render(mine, bob);
			log.push(`type ${JSON.stringify(mine)} at ${path}`);
			expectOk(await w.alice.repo.files.writeText(path, text));
			m.path = path;
			m.shown = { mine, bob, whole: null };
			const below = promisedText(m);
			// The gate: it parses, or what is below exists and does not parse either.
			if (!mine.broken || (below !== null && !parses(below))) {
				m.held = false;
				m.queued = text;
				m.lands = { mine, bob };
			} else m.held = text !== below;
		},
		/** Alice types a text that parses; it lands, but its reply is lost and she goes offline. */
		async typeLost() {
			if (offline || m.queued !== null) return;
			const mine: Mine = { title: pick(['A', 'B', 'C', 'D']), broken: false };
			const path = m.path ?? lastPath;
			const bob = m.shown.whole !== null && m.server !== null ? m.server.bob : m.shown.bob;
			const text = render(mine, bob);
			log.push(`type ${JSON.stringify(mine)} at ${path}, reply lost`);
			w.release();
			w.network.dropNextReply();
			expectOk(await w.alice.repo.files.writeText(path, text));
			await w.alice.repo.flush();
			w.hold();
			offline = true;
			m.path = path;
			m.shown = { mine, bob, whole: null };
			m.held = false;
			m.queued = text;
			m.lands = { mine, bob };
			m.server = { path, mine, bob: m.server?.bob ?? bob };
		},
		async reconnect() {
			if (!offline) return;
			log.push('reconnect');
			w.release();
			w.network.setOnline(true);
			await w.alice.repo.flush();
			await w.alice.repo.flush();
			w.hold();
			offline = false;
			if (m.lands !== null && m.path !== null)
				m.server = { path: m.path, mine: m.lands.mine, bob: m.server !== null ? m.server.bob : m.lands.bob };
			// Her hello brought what Bob changed while she was away.
			if (m.server !== null && m.shown.whole === null) m.shown = { ...m.shown, bob: m.server.bob };
			m.queued = null;
			m.lands = null;
		},
		/**
		 * Bob edits his line. While Alice is offline after a lost reply, she
		 * hears it only at her hello, which also tells her that batch landed:
		 * the retry's answer from its receipt is then older than what she heard.
		 */
		async bobEdit() {
			if (m.server === null || m.shown.whole !== null) return;
			const line = pick(['b1', 'b2', 'b3', 'b4']);
			log.push(`bob edits ${line}`);
			const text = await w.bob.files.readText(m.server.path);
			if (text === null) throw new Error('Bob shows the file');
			expectOk(await w.bob.files.writeText(m.server.path, text.text.replace(/\n[^\n]*\n$/, `\n${line}\n`)));
			m.server = { ...m.server, bob: line };
			// Alice shows the same note, at the server's path or where her queued rename took it.
			if (m.path !== null && !offline) m.shown = { ...m.shown, bob: line };
		},
		async ack() {
			if (offline) return;
			if (!w.gated()) return;
			log.push('ack');
			w.release();
			await w.alice.repo.flush();
			w.hold();
			if (m.lands !== null && m.path !== null)
				m.server = { path: m.path, mine: m.lands.mine, bob: m.server !== null ? m.server.bob : m.lands.bob };
			m.queued = null;
			m.lands = null;
		},
		async rename() {
			if (offline) return;
			if (m.path === null || promisedText(m) === null || m.server?.path !== m.path || m.shown.whole !== null) return;
			const to = freshPath();
			log.push(`alice renames to ${to}`);
			expectOk(await w.alice.repo.notes.move({ stem: stemOf(m.path) }, { stem: stemOf(to) }));
			m.queued = promisedText(m);
			m.lands ??= { mine: m.server.mine, bob: m.server.bob };
			m.path = to;
			lastPath = to;
		},
		async bobRename() {
			if (offline) return;
			if (m.server === null || m.queued !== null || m.path !== m.server.path) return;
			const to = freshPath();
			log.push(`bob renames to ${to}`);
			expectOk(await w.bob.notes.move({ stem: stemOf(m.server.path) }, { stem: stemOf(to) }));
			m.server = { ...m.server, path: to };
			m.path = to;
			lastPath = to;
		},
		async bobDelete() {
			if (offline) return;
			if (m.server === null || m.queued !== null || m.path !== m.server.path) return;
			log.push('bob deletes');
			expectOk(await w.bob.notes.delete({ stem: stemOf(m.server.path) }));
			m.server = null;
			if (!m.held) m.path = null;
		},
		async bobReuse() {
			if (offline) return;
			if (m.server !== null || m.queued !== null) return;
			const mine: Mine = { title: 'R', broken: false };
			log.push(`bob reuses ${lastPath}`);
			expectOk(await w.bob.files.writeText(lastPath, render(mine, 'reused')));
			m.server = { path: lastPath, mine, bob: 'reused' };
			if (m.path === null) m.shown = { mine, bob: 'reused', whole: null };
			else {
				// Two creates at one path keep both texts, this device's first.
				m.shown = { ...m.shown, whole: `${shownText(m)}${render(mine, 'reused')}` };
			}
			m.path = lastPath;
		},
		async restart() {
			log.push('restart');
			w.alice.repo.close();
			w.alice = w.openAlice();
		},
	};
	const names = Object.keys(steps) as (keyof typeof steps)[];
	try {
		await check();
		w.hold();
		for (let step = 0; step < STEPS; step++) {
			// With no file shown, a lost reply on the create that makes one again is the interesting case.
			await steps[m.path === null && !offline && random() < 0.5 ? 'typeLost' : pick(names)]();
			await settled();
			await check();
		}
		await steps.reconnect();
		log.push('final ack');
		await steps.ack();
		await settled();
		await check();
	} catch (cause) {
		const state = JSON.stringify(
			{ model: m, alice: await w.alice.repo.files.list(), server: m.server === null ? null : await w.server.read(m.server.path), pushed: w.pushed },
			null,
			1,
		);
		throw new Error(`HELD_SEED=${seed} failed after:\n${log.join('\n')}\n${cause instanceof Error ? cause.message : String(cause)}\n${process.env.HELD_DEBUG ? state : ''}`);
	} finally {
		w.release();
		w.alice.repo.close();
		w.bob.close();
		await w.cleanup();
	}
}

const only = process.env.HELD_SEED;
test('held text: the engine matches the model of its levels, and nothing failing the gate reaches the server', async () => {
	const seeds = only !== undefined ? [Number(only)] : Array.from({ length: RUNS }, (_, run) => 1000 + run);
	for (const seed of seeds) await run(seed);
}, 120_000);
