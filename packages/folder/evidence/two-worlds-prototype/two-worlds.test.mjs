// PROTOTYPE (throwaway): claims 1 to 4 of ADR-0692. Run: bun test packages/folder/evidence/two-worlds-prototype
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	bodyNode,
	identity,
	readFiles,
	seededDoc,
	seedUpdate,
} from './core.mjs';
import { Agent, Device, Git, Server } from './world.mjs';

const para = (n, word = 'original') => `Paragraph ${n} is ${word}.\n`;
const note = (title, paras) => ({
	fields: { title, pinned: false },
	body: paras.join('\n'),
});
const initial = () =>
	new Map([
		[
			'notes/a.md',
			note(
				'A',
				[1, 2, 3, 4, 5, 6].map((n) => para(n)),
			),
		],
		[
			'notes/b.md',
			note(
				'B',
				[1, 2, 3].map((n) => para(n)),
			),
		],
		[
			'notes/c.md',
			note(
				'C',
				[1].map((n) => para(n)),
			),
		],
	]);
const replaceLine = (_, from, to) => (f) => ({
	...f,
	body: f.body.replace(from, to),
});
const body = (device, path) => device.files().get(path).body;
const world = () => {
	const git = new Git(initial());
	const server = new Server('braden/notes', git);
	return { git, server };
};

describe('claim 1: seeding from a commit is deterministic', () => {
	test('two independent seeds are byte-identical and merge edits without duplicating text', () => {
		const id = identity('braden/notes', 'c0ffee');
		const [ua, ub] = [seedUpdate(id, initial()), seedUpdate(id, initial())];
		expect(Buffer.compare(Buffer.from(ua), Buffer.from(ub))).toBe(0);
		const a = seededDoc(id, initial()),
			b = seededDoc(id, initial());
		expect(a.clientID).not.toBe(b.clientID);
		bodyNode(a, 'notes/a.md').insert(0, 'from a\n');
		bodyNode(b, 'notes/b.md').insert(0, 'from b\n');
		Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a)));
		Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b)));
		expect(readFiles(a).get('notes/a.md').body).toBe(
			'from a\n' + initial().get('notes/a.md').body,
		);
		expect(readFiles(a).get('notes/b.md').body).toBe(
			'from b\n' + initial().get('notes/b.md').body,
		);
		expect(Y.encodeStateAsUpdateV2(a)).toEqual(Y.encodeStateAsUpdateV2(b));
	});
	test('control: seeding under random client ids duplicates every file on merge', () => {
		const seedRandom = () => {
			const d = new Y.Doc();
			const r = d.get('files');
			for (const [p, f] of initial()) {
				const n = new Y.Node();
				r.setAttr(p, n);
				const b = new Y.Node();
				n.insert(0, [b]);
				b.insert(0, f.body);
			}
			return d;
		};
		const a = seedRandom(),
			b = seedRandom();
		bodyNode(a, 'notes/c.md').insert(0, 'x');
		bodyNode(b, 'notes/c.md').insert(0, 'y');
		Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b));
		Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));
		// The path resolves to one seed's node; the other seed's node and the edit made under it are dropped.
		const t = readFiles(a).get('notes/c.md').body;
		expect(t.startsWith('x') !== t.startsWith('y')).toBe(true);
	});
	test('a device on the new epoch receives no seed bytes from the server', () => {
		const { server } = world();
		const a = new Device('a', server);
		a.connect();
		expect(a.stats.fetched).toBe(3); // first open downloads text, not a document
		expect(a.stats.seedBytesReceived).toBeLessThan(20); // the handshake diff after seeding is empty
	});
});

describe('claim 2: the quiet switch loses nothing', () => {
	test('edits survive; both devices land on identical documents; at rest only Git remains', () => {
		const { git, server } = world();
		const a = new Device('a', server),
			b = new Device('b', server);
		a.connect();
		b.connect();
		a.edit('notes/a.md', replaceLine('', para(2), para(2, 'from a')));
		b.edit('notes/b.md', (f) => ({
			...f,
			fields: { ...f.fields, pinned: true },
		}));
		expect(body(b, 'notes/a.md')).toContain('from a'); // live across devices
		a.disconnect();
		b.disconnect();
		expect(server.fireAlarm()).toBe(true);
		expect(server.doc).toBeNull(); // the Yjs state is deleted
		expect(git.files(git.main).get('notes/a.md').body).toContain('from a');
		expect(git.files(git.main).get('notes/b.md').fields.pinned).toBe(true);
		a.connect();
		b.connect();
		expect([a.stats.switches, b.stats.switches]).toEqual([2, 2]);
		expect([a.stats.carried, b.stats.carried]).toEqual([0, 0]);
		expect([a.stats.fetched, b.stats.fetched]).toEqual([3, 3]); // nothing new fetched: last-synced text already matched
		expect(Y.encodeStateAsUpdateV2(a.doc)).toEqual(
			Y.encodeStateAsUpdateV2(b.doc),
		);
		expect(Y.encodeStateAsUpdateV2(a.doc)).toEqual(
			Y.encodeStateAsUpdateV2(server.doc),
		);
	});
	test('a device that connects before the alarm keeps the epoch', () => {
		const { server } = world();
		const a = new Device('a', server);
		a.connect();
		a.disconnect();
		a.connect();
		expect(server.fireAlarm()).toBe(false);
		expect(a.stats.switches).toBe(1);
	});
});

describe('claim 3: an offline carry-over keeps its edits without undoing edits it never saw', () => {
	const setup = () => {
		const w = world();
		const a = new Device('a', w.server),
			b = new Device('b', w.server);
		a.connect();
		b.connect();
		return { ...w, a, b };
	};
	test('different paragraphs and files', () => {
		const { git, server, a, b } = setup();
		a.disconnect();
		a.edit(
			'notes/a.md',
			replaceLine('', para(2), para(2, 'edited offline by a')),
		);
		b.edit('notes/a.md', replaceLine('', para(5), para(5, 'edited by b')));
		b.edit('notes/c.md', replaceLine('', para(1), para(1, 'b only')));
		b.disconnect();
		server.fireAlarm();
		a.connect();
		expect(a.stats.carried).toBe(1);
		expect(a.stats.fetched).toBe(3 + 2); // only the two files b changed
		const t = body(a, 'notes/a.md');
		expect(t).toContain('edited offline by a');
		expect(t).toContain('edited by b');
		expect(body(a, 'notes/c.md')).toContain('b only'); // not undone
		a.disconnect();
		server.fireAlarm();
		expect(git.files(git.main).get('notes/a.md').body).toBe(t);
	});
	test('the same paragraph keeps both versions (the stray-fragment case)', () => {
		const { server, a, b } = setup();
		a.disconnect();
		a.edit('notes/a.md', replaceLine('', para(3), para(3, 'rewritten by a')));
		b.edit('notes/a.md', replaceLine('', para(3), para(3, 'rewritten by b')));
		b.disconnect();
		server.fireAlarm();
		a.connect();
		const t = body(a, 'notes/a.md');
		console.log('same-paragraph result:\n' + t);
		expect(t).toContain('rewritten by a');
		expect(t).toContain('rewritten by b');
	});
	test('an offline edit beats a delete it never saw', () => {
		const { server, a, b } = setup();
		a.disconnect();
		a.edit('notes/b.md', replaceLine('', para(1), para(1, 'kept')));
		b.doc.get('files').deleteAttr('notes/b.md');
		b.disconnect();
		server.fireAlarm();
		a.connect();
		expect(body(a, 'notes/b.md')).toContain('kept');
	});
});

describe('claim 4: a push merges into live typing; an overlapping push is rejected', () => {
	test('clean push lands while keystrokes are in flight, and both survive', () => {
		const { git, server } = world();
		const a = new Device('a', server),
			b = new Device('b', server);
		a.connect();
		b.connect();
		b.edit(
			'notes/b.md',
			replaceLine('', para(2), para(2, 'b, delivered before the push')),
		); // main's live state moves past the agent's base
		a.hold(); // keystrokes typed but not yet delivered
		for (const ch of 'typing ')
			bodyNode(a.doc, 'notes/a.md').insert(0, ch === ' ' ? ' ' : ch);
		const r = new Agent(git, server)
			.pull()
			.edit(
				'notes/a.md',
				replaceLine('', para(5), para(5, 'rewritten by agent')),
			)
			.push('agent edit');
		expect(r).toEqual({ accepted: true, fastForward: false });
		expect(body(a, 'notes/a.md')).toContain('rewritten by agent'); // arrives like a collaborator's typing
		a.release();
		for (const d of [a, b]) {
			expect(body(d, 'notes/a.md').startsWith(' gnipyt')).toBe(true);
			expect(body(d, 'notes/a.md')).toContain('rewritten by agent');
		}
		expect(git.log()[0].parents.length).toBe(2); // a merge commit: checkpoint P and the agent's commit
		a.disconnect();
		b.disconnect();
		server.fireAlarm();
		const committed = git.files(git.main);
		expect(committed.get('notes/a.md').body.startsWith(' gnipyt')).toBe(true);
		expect(committed.get('notes/b.md').body).toContain(
			'delivered before the push',
		);
	});
	test('overlapping push is rejected, then lands after the agent pulls and merges', () => {
		const { git, server } = world();
		const a = new Device('a', server);
		a.connect();
		const agent = new Agent(git, server)
			.pull()
			.edit('notes/a.md', replaceLine('', para(4), para(4, 'agent version')));
		a.edit('notes/a.md', replaceLine('', para(4), para(4, 'person version')));
		const r = agent.push('agent edit');
		expect(r.accepted).toBe(false);
		expect(r.reason).toContain('notes/a.md');
		expect(body(a, 'notes/a.md')).toContain('person version');
		expect(body(a, 'notes/a.md')).not.toContain('agent version');
		const retry = agent
			.rebase(
				'notes/a.md',
				replaceLine(
					'',
					para(4, 'person version'),
					para(4, 'person version, then agent'),
				),
			)
			.push('agent resolves');
		expect(retry.accepted).toBe(true);
		expect(body(a, 'notes/a.md')).toContain('person version, then agent');
	});
});
