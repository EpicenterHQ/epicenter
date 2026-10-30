/**
 * An answer that says this device's push is in `main` lands one way.
 *
 * The night review's probe (H1): bob creates `notes/todo.md` while alice's
 * `notes/Todo.md` lands, and types more while his create is in flight. The
 * server lands his create at the file, in `main`'s spelling: the server
 * ends with alice's line, bob's and what he typed. (A resend is answered
 * exactly, from the writer's record, so there is no other answer to it.)
 */
import { expect, test } from 'bun:test';
import { openBunSqlite } from '../bun/sqlite.js';
import { openReplica, type Reply, type Request } from '../client/replica.js';
import { createTestServer, writer } from './harness.js';

const note = (body: string) => `---\ntitle: Todo\n---\n${body}`;
const SERVER = 'example';

function device(
	server: ReturnType<typeof createTestServer>,
	account: string,
	id: string,
) {
	const binding = { repository: 'r1', server: SERVER, account };
	const opened = openReplica({
		driver: openBunSqlite(),
		binding,
		device: id,
		after: () => {},
		now: () => 0,
		quiet: 0,
	});
	if (opened.error !== null) throw new Error(opened.error.message);
	const replica = opened.data;
	replica.hello({
		...binding,
		server: SERVER,
		main: server.main(),
		user: account,
		limits: server.sizing(),
	});
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	const reply = (request: Request): Reply => {
		if (request.type === 'push')
			return {
				type: 'answer',
				rid: request.rid,
				answer: server.push(request.push, writer(account)),
			};
		if (request.type === 'catch-up')
			return {
				type: 'caught-up',
				rid: request.rid,
				catchUp: server.catchUp(request),
			};
		return {
			type: 'fetched',
			rid: request.rid,
			versions: server.fetch(request.hashes),
		};
	};
	return {
		replica,
		sent,
		deliver() {
			for (
				let request = sent.shift();
				request !== undefined;
				request = sent.shift()
			)
				replica.reply(reply(request));
		},
	};
}

test("a landed answer: work saved over a create in flight under another spelling meets main's", () => {
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
	const answer = server.push(push.push, writer('bob'));
	if (answer.kind !== 'applied' && answer.kind !== 'merged')
		throw new Error(`the push was ${answer.kind}`);
	// Bob types more before the answer comes.
	bob.replica.edit('notes/todo.md', (text) => `${text ?? ''}more\n`);
	bob.replica.reply({ type: 'answer', rid: push.rid, answer });
	for (let round = 0; round < 3; round++) bob.deliver();
	const text = server.read('notes/Todo.md') ?? '';
	for (const line of ['alice', 'bob', 'more']) expect(text).toContain(line);
	expect([...bob.replica.files().keys()]).toEqual(['notes/Todo.md']);
});
