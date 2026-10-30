/**
 * Every answer that says this device's commit is in `main` lands one way.
 *
 * The night review's probe (H1): bob creates `notes/todo.md` while alice's
 * `notes/Todo.md` lands, and types more while his create is in flight. The
 * server spells his create to `main`'s path. The same answer is delivered
 * as the real `merged` (or `applied`) answer, and as the `flushed` answer a
 * resend gets once the outcome left its window: either way the server ends
 * with alice's line, bob's and what he typed.
 */
import { expect, test } from 'bun:test';
import { openBunSqlite } from '../bun/sqlite.js';
import { openReplica, type Reply, type Request } from '../client/replica.js';
import type { PushAnswer } from '../server/server.js';
import { createTestServer, writer } from './harness.js';

const note = (body: string) => `---\ntitle: Todo\n---\n${body}`;
const SERVER = 'example';

function device(server: ReturnType<typeof createTestServer>, account: string, id: string) {
	const binding = { repository: 'r1', server: SERVER, account };
	const opened = openReplica({ driver: openBunSqlite(), binding, device: id, after: () => {}, now: () => 0, quiet: 0 });
	if (opened.error !== null) throw new Error(opened.error.message);
	const replica = opened.data;
	replica.hello({ ...binding, server: SERVER, main: server.main(), user: account, limits: server.sizing() });
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	const reply = (request: Request): Reply => {
		if (request.type === 'push') return { type: 'answer', rid: request.rid, answer: server.push(request.commit, writer(account)) };
		if (request.type === 'catch-up') return { type: 'caught-up', rid: request.rid, catchUp: server.catchUp(request) };
		return { type: 'fetched', rid: request.rid, texts: server.fetch(request.hashes) };
	};
	return {
		replica,
		sent,
		deliver() {
			for (let request = sent.shift(); request !== undefined; request = sent.shift()) replica.reply(reply(request));
		},
	};
}

for (const kind of ['merged', 'flushed'] as const)
	test(`a ${kind} answer: work saved over a create in flight under another spelling meets main's`, () => {
		const server = createTestServer();
		const alice = device(server, 'alice', 'a');
		const bob = device(server, 'bob', 'b');
		alice.deliver();
		bob.deliver();
		alice.replica.write('notes/Todo.md', note('alice\n'), { over: null });
		alice.deliver();
		bob.replica.write('notes/todo.md', note('bob\n'), { over: null });
		const push = bob.sent.shift();
		if (push?.type !== 'push') throw new Error('bob sent no push');
		const real = server.push(push.commit, writer('bob'));
		if (real.kind !== 'applied' && real.kind !== 'merged') throw new Error(`the push was ${real.kind}`);
		// Bob types more before the answer comes.
		bob.replica.edit('notes/todo.md', (text) => `${text ?? ''}more\n`);
		const answer: PushAnswer =
			kind === 'merged'
				? real
				: { kind: 'flushed', main: server.main(), files: real.files.filter((f) => ['notes/todo.md', 'notes/Todo.md'].includes(f.path)).map(({ deleted: _, ...file }) => file) };
		bob.replica.reply({ type: 'answer', rid: push.rid, answer });
		for (let round = 0; round < 3; round++) bob.deliver();
		const text = server.read('notes/Todo.md') ?? '';
		for (const line of ['alice', 'bob', 'more']) expect(text).toContain(line);
		expect([...bob.replica.files().keys()]).toEqual(['notes/Todo.md']);
	});
