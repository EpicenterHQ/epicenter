/**
 * Server commits and Git push-as-merge: builds one scenario on a temporary
 * bare repository through the real server and prints `git log --graph`.
 *
 * Devices send writes over file versions; the server makes their single-parent
 * commits. Alice and Bob type (Bob's stale base writes a conflict block, Alice
 * resolves it, Bob saves another note), an agent pushes over those
 * unexported edits, typing goes on, the agent pushes again from its own
 * pushed commit before any flush, a flush joins them, then the agent
 * fetches and pushes once more on a quiet repository.
 *
 * Run: bun scripts/push-merge-graph.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunGitStore } from '../src/bun/git.js';
import { openBunSqlite } from '../src/bun/sqlite.js';
import type { CommitFile } from '../src/core/commit.js';
import { MAIN } from '../src/server/git-store.js';
import {
	createServer,
	type Server,
	type Session,
} from '../src/server/server.js';

import { directPush } from '../src/sim/harness.js';

const EPOCH = Date.UTC(2026, 9, 30, 12);
const note = (body: string) => `---\ntitle: Note\n---\n${body}`;
const alice: Session = { user: 'alice', role: 'writer' };
const bob: Session = { user: 'bob', role: 'writer' };
const agent: Session = { user: 'agent', role: 'writer' };
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
};

const dir = await mkdtemp(join(tmpdir(), 'epicenter-graph-'));
const path = join(dir, 'repo.git');
const git = await openBunGitStore(path);
let now = EPOCH;
const server = createServer({ store: openBunSqlite(), git, clock: () => now });
const encoder = new TextEncoder();
const sequences = new Map<string, number>();

function save(
	server: Server,
	who: Session,
	files: (CommitFile & { base?: string | null })[],
) {
	now += 60_000;
	const seq = (sequences.get(who.user) ?? 0) + 1;
	sequences.set(who.user, seq);
	return server.push(
		{
			...directPush(server, who.user, files, {
				device: 'laptop',
				time: new Date(now).toISOString(),
			}),
			epoch: `graph-${who.user}`,
			seq,
		},
		who,
	);
}
async function commitOn(
	parent: string,
	changes: Record<string, string | null>,
	message: string,
) {
	now += 60_000;
	const tree = await git.readTree((await git.readCommit(parent))?.tree ?? '');
	for (const [p, text] of Object.entries(changes)) {
		if (text === null) tree.delete(p);
		else
			tree.set(p, {
				mode: '100644',
				oid: await git.writeBlob(encoder.encode(text)),
			});
	}
	return git.writeCommit({
		tree: await git.writeTree(tree),
		parents: [parent],
		message,
		author: { name: 'agent', email: 'agent@example.com' },
		at: new Date(now),
	});
}
const head = async () => (await git.readRef(MAIN)) as string;
const short = (oid: string) => oid.slice(0, 7);

save(server, alice, [
	{ path: 'notes/plan.md', text: note('Ship on Friday.\n') },
	{ path: 'notes/todo.md', text: note('- write docs\n') },
]);
await server.flush();
const g0 = await head();
console.log(`flushed: Git main ${short(g0)}`);

const base = server.version('notes/plan.md');
save(server, alice, [
	{ path: 'notes/plan.md', text: note('Ship on Monday.\n') },
]);
save(server, bob, [
	{ path: 'notes/plan.md', base, text: note('Ship on Tuesday.\n') },
]);
save(server, alice, [
	{ path: 'notes/plan.md', text: note('Ship on Tuesday.\n') },
]);
save(server, bob, [
	{ path: 'notes/todo.md', text: note('- write docs\n- review\n') },
]);

const p1 = await commitOn(
	g0,
	{
		'agent/log.md': note('Ran the tests.\n'),
		'agent/scratch.md': note('temp\n'),
	},
	'agent: run the tests\n',
);
console.log(
	'push 1:',
	JSON.stringify(await server.receive({ ref: MAIN, old: g0, next: p1 }, agent)),
);
save(server, alice, [
	{ path: 'notes/todo.md', text: note('- write docs\n- review\n- ship\n') },
]);
const p2 = await commitOn(
	p1,
	{
		'agent/log.md': note('Ran the tests.\nFixed the build.\n'),
		'agent/scratch.md': null,
	},
	'agent: fix the build\n',
);
console.log(
	'push 2 (on push 1, before any flush):',
	JSON.stringify(await server.receive({ ref: MAIN, old: p1, next: p2 }, agent)),
);
save(server, bob, [
	{ path: 'notes/plan.md', text: note('Ship on Tuesday, after review.\n') },
]);
console.log('flush:', JSON.stringify((await server.flush()).kind));
const g1 = await head();
const p3 = await commitOn(
	g1,
	{
		'agent/log.md': note(
			'Ran the tests.\nFixed the build.\nTagged the release.\n',
		),
	},
	'agent: tag the release\n',
);
console.log(
	'push 3 (fetched, nothing live ahead):',
	JSON.stringify(await server.receive({ ref: MAIN, old: g1, next: p3 }, agent)),
);
save(server, alice, [
	{ path: 'notes/plan.md', text: note('Shipped Tuesday.\n') },
]);
await server.flush();

const log = (args: string[]) =>
	new TextDecoder().decode(
		Bun.spawnSync(['git', '-C', path, 'log', ...args, MAIN], { env }).stdout,
	);
console.log(`\npushed: ${short(p1)} ${short(p2)} ${short(p3)}\n`);
console.log('$ git log --graph --format="%h %s (%an)" main');
console.log(log(['--graph', '--format=%h %s (%an)']));
console.log('$ git log --first-parent --format="%h %s" main');
console.log(log(['--first-parent', '--format=%h %s']));
console.log(
	'$ git fsck --strict:',
	Bun.spawnSync(['git', '-C', path, 'fsck', '--strict'], { env }).exitCode === 0
		? 'clean'
		: 'FAILED',
);
await rm(dir, { recursive: true, force: true });
