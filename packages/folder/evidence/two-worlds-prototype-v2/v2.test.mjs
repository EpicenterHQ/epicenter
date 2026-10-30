// PROTOTYPE v2 (throwaway): the claims ADR-0692 added after the first prototype.
// Run: bun test packages/folder/evidence/two-worlds-prototype-v2
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { materialize, parseRowText, readState } from './core.mjs';
import { Agent, Device, Git, Server } from './world.mjs';

const para = (n, w = 'original') => `Paragraph ${n} is ${w}.\n`;
const body6 = [1, 2, 3, 4, 5, 6].map((n) => para(n)).join('\n');
const initial = () =>
	new Map([
		['notes/trip.md', `---\ntitle: Trip\npinned: false\n---\n${body6}`],
		['notes/ideas.md', `---\ntitle: Ideas\npinned: true\n---\nSome ideas.\n`],
		['kv.json', '{\n  "theme": "dark"\n}\n'],
		['research/raw-notes.txt', 'not a row; kept, never loaded\n'],
	]);
const world = () => {
	const git = new Git(initial());
	const server = new Server(git);
	return { git, server };
};
const two = () => {
	const w = world();
	const a = new Device('a', w.server),
		b = new Device('b', w.server);
	a.connect();
	b.connect();
	return { ...w, a, b };
};
const file = (git, path) => git.files().get(path);

describe('stable ids', () => {
	test('the first checkpoint writes an id as the first key of every row', () => {
		const { git } = world();
		for (const p of ['notes/trip.md', 'notes/ideas.md'])
			expect(file(git, p)).toMatch(/^---\nid: r[0-9a-z]+\n/);
	});
	test('a rename in an app does not lose typing on another device', () => {
		const { git, server, a, b } = two();
		const { id } = a.rowAt('notes/trip.md');
		b.hold();
		b.body(id).insert(0, 'typed during the rename\n');
		a.rename(id, 'notes/trip-to-japan.md');
		b.release();
		for (const d of [a, b]) {
			const r = d.state().rows.get(id);
			expect(r.path).toBe('notes/trip-to-japan.md');
			expect(r.body.startsWith('typed during the rename')).toBe(true);
		}
		server.checkpoint();
		expect(file(git, 'notes/trip.md')).toBeUndefined();
		expect(file(git, 'notes/trip-to-japan.md')).toContain(
			'typed during the rename',
		);
	});
	test('control: keyed by path, the same rename loses the typing', () => {
		const d1 = new Y.Doc(),
			d2 = new Y.Doc();
		const r1 = d1.get('rows');
		const n = new Y.Node();
		r1.setAttr('notes/trip.md', n);
		n.insert(0, 'body\n');
		Y.applyUpdateV2(d2, Y.encodeStateAsUpdateV2(d1));
		d2.get('rows')
			.getAttr('notes/trip.md')
			.insert(0, 'typed during the rename\n');
		d1.transact(() => {
			const m = new Y.Node();
			r1.setAttr('notes/trip-to-japan.md', m);
			m.insert(0, n.toArray().join(''));
			r1.deleteAttr('notes/trip.md');
		});
		Y.applyUpdateV2(d1, Y.encodeStateAsUpdateV2(d2));
		Y.applyUpdateV2(d2, Y.encodeStateAsUpdateV2(d1));
		expect(
			d1.get('rows').getAttr('notes/trip-to-japan.md').toArray().join(''),
		).not.toContain('typed during the rename');
	});
	test('git mv by an agent while someone types keeps the id and the typing', () => {
		const { git, server, a } = two();
		const { id } = a.rowAt('notes/trip.md');
		const agent = new Agent(git, server)
			.pull()
			.move('notes/trip.md', 'notes/japan.md');
		a.body(id).insert(0, 'typed meanwhile\n');
		expect(agent.push().accepted).toBe(true);
		const r = a.state().rows.get(id);
		expect(r.path).toBe('notes/japan.md');
		expect(r.body.startsWith('typed meanwhile')).toBe(true);
	});
	test('repair: a copied file gets a new id; a deleted id line keeps its id; a new file gets one written', () => {
		const { git, server, a } = two();
		const trip = a.rowAt('notes/trip.md').id,
			ideas = a.rowAt('notes/ideas.md').id;
		const r = new Agent(git, server)
			.pull()
			.copy('notes/trip.md', 'notes/trip-copy.md')
			.edit('notes/ideas.md', (t) => t.replace(/^id: .*\n/m, ''))
			.write('notes/new.md', '---\ntitle: New\n---\nFresh.\n')
			.push();
		expect(r).toEqual({ accepted: true, newIdsWritten: true });
		const s = a.state();
		expect(s.rows.get(trip).path).toBe('notes/trip.md');
		expect(s.rows.get(ideas).path).toBe('notes/ideas.md');
		const copy = a.rowAt('notes/trip-copy.md'),
			fresh = a.rowAt('notes/new.md');
		expect(copy.id).not.toBe(trip);
		expect(fresh).toBeDefined();
		expect(file(git, 'notes/trip-copy.md')).toContain(`id: ${copy.id}`);
		expect(file(git, 'notes/ideas.md')).toContain(`id: ${ideas}`);
		expect(file(git, 'notes/new.md')).toContain(`id: ${fresh.id}`);
	});
});

describe('push merges by field, by key, by line; schemas play no part', () => {
	test('an agent sets pinned while a person edits the title: clean', () => {
		const { git, server, a } = two();
		const { id } = a.rowAt('notes/ideas.md');
		const agent = new Agent(git, server)
			.pull()
			.edit('notes/ideas.md', (t) =>
				t.replace('pinned: true', 'pinned: false'),
			);
		a.setField(id, 'title', 'Better ideas');
		expect(agent.push().accepted).toBe(true);
		expect(a.state().rows.get(id).fields).toEqual({
			title: 'Better ideas',
			pinned: false,
		});
	});
	test('the same field changed both ways is rejected, naming the file and field', () => {
		const { git, server, a } = two();
		const { id } = a.rowAt('notes/ideas.md');
		const agent = new Agent(git, server)
			.pull()
			.edit('notes/ideas.md', (t) =>
				t.replace('title: Ideas', 'title: Agent title'),
			);
		a.setField(id, 'title', 'Person title');
		const r = agent.push();
		expect(r.accepted).toBe(false);
		expect(r.reason).toContain('notes/ideas.md: field title');
	});
	test('kv.json merges by key; unknown keys are kept; the file is canonical', () => {
		const { git, server, a } = two();
		const agent = new Agent(git, server)
			.pull()
			.write('kv.json', '{"defaultView":"board","zzExtra":1,"theme":"dark"}');
		a.setKv('theme', 'light');
		a.declareOrder('kv', ['theme', 'defaultView']);
		expect(agent.push().accepted).toBe(true);
		expect(a.state().kv).toEqual({
			theme: 'light',
			defaultView: 'board',
			zzExtra: 1,
		});
		expect(file(git, 'kv.json')).toBe(
			'{\n  "theme": "light",\n  "defaultView": "board",\n  "zzExtra": 1\n}\n',
		);
	});
	test('a row that breaks the app schema is accepted and shows as an issue in the app', () => {
		const { git, server, a } = two();
		expect(
			new Agent(git, server)
				.pull()
				.edit('notes/ideas.md', (t) =>
					t.replace('pinned: true', 'pinned: "yes please"'),
				)
				.push().accepted,
		).toBe(true);
		const note = Type.Object({ title: Type.String(), pinned: Type.Boolean() });
		const issues = [...a.state().rows.values()]
			.filter((r) => !r.raw && !Check(note, r.fields))
			.map((r) => r.path);
		expect(issues).toEqual(['notes/ideas.md']);
	});
	test('an invalid file is kept byte for byte, shown as source, and becomes a row once fixed', () => {
		const { git, server, a } = two();
		const broken = '---\ntitle: [unclosed\n---\nBody.\n';
		expect(
			new Agent(git, server).pull().write('notes/broken.md', broken).push()
				.accepted,
		).toBe(true);
		const r = a.rowAt('notes/broken.md');
		expect(r.raw).toBe(true);
		expect(r.source).toBe(broken);
		server.checkpoint();
		expect(file(git, 'notes/broken.md')).toBe(broken);
		// the person fixes the source in the app; the app reparses and writes structure
		const fixed = '---\ntitle: Fixed\n---\nBody.\n',
			parsed = parseRowText(fixed);
		a.doc.transact(() => {
			const n = a.node(r.id);
			n.deleteAttr('raw');
			for (const [k, v] of Object.entries(parsed.fields))
				n.get(0).setAttr(k, v);
			const b = n.get(1);
			b.delete(0, b.length);
			b.insert(0, parsed.body);
		});
		a.disconnect();
		server.checkpoint();
		expect(file(git, 'notes/broken.md')).toBe(
			`---\nid: ${r.id}\ntitle: Fixed\n---\nBody.\n`,
		);
	});
	test('paths outside the canonical layout are kept and never loaded', () => {
		const { git, server, a } = two();
		expect(
			[...a.state().rows.values()].some((r) => r.path.startsWith('research/')),
		).toBe(false);
		expect(
			new Agent(git, server)
				.pull()
				.edit('research/raw-notes.txt', (t) => t + 'more\n')
				.push().accepted,
		).toBe(true);
		a.setKv('theme', 'light');
		a.disconnect();
		expect(file(git, 'research/raw-notes.txt')).toBe(
			'not a row; kept, never loaded\nmore\n',
		);
	});
});

describe('a permanent document', () => {
	test('a device back after a long time offline merges like a live peer', () => {
		const { git, server, a, b } = two();
		const { id } = a.rowAt('notes/trip.md');
		a.disconnect();
		for (let i = 0; i < 200; i++)
			a.body(id).insert(0, i % 50 === 0 ? `offline ${i}\n` : '');
		a.body(id).insert(0, 'a was away\n');
		b.setField(id, 'pinned', true);
		b.body(id).insert(b.body(id).length, 'b kept editing\n');
		new Agent(git, server)
			.pull()
			.edit('notes/ideas.md', (t) => t + 'agent addition\n')
			.push();
		b.disconnect();
		a.connect();
		const r = a.state().rows.get(id);
		expect(r.body.startsWith('a was away')).toBe(true);
		expect(r.body).toContain('b kept editing');
		expect(r.fields.pinned).toBe(true);
		expect(a.rowAt('notes/ideas.md').body).toContain('agent addition');
	});
	test('two people rewriting one paragraph merge by character, online or offline alike', () => {
		const { server, a, b } = two();
		const { id } = a.rowAt('notes/trip.md');
		a.disconnect();
		const rewrite = (d, w) => {
			const t = d.body(id).toArray().join(''),
				at = t.indexOf('original');
			d.body(id).delete(at, 8);
			d.body(id).insert(at, w);
		};
		rewrite(a, 'rewritten by a');
		rewrite(b, 'rewritten by b');
		a.connect();
		const line = a.state().rows.get(id).body.split('\n')[0];
		console.log('one rule for every case:', JSON.stringify(line));
		expect(line).toContain('rewritten by a');
		expect(line).toContain('rewritten by b');
		expect(server.doc && Y.encodeStateAsUpdateV2(a.doc)).toEqual(
			Y.encodeStateAsUpdateV2(b.doc),
		);
	});
});

describe('formatting, binary files, migrations', () => {
	test('materializing is deterministic: id, declared order, then unknown keys sorted', () => {
		const { a } = two();
		const { id } = a.rowAt('notes/ideas.md');
		a.setField(id, 'zeta', 1);
		a.setField(id, 'alpha', 2);
		a.declareOrder('notes', ['title', 'pinned']);
		const once = materialize(a.state()),
			twice = materialize(readState(a.doc));
		expect(once.get('notes/ideas.md')).toBe(
			`---\nid: ${id}\ntitle: Ideas\npinned: true\nalpha: 2\nzeta: 1\n---\nSome ideas.\n`,
		);
		expect([...once]).toEqual([...twice]);
	});
	test('an upload adds a pointer entry; the commit writes an LFS pointer; a relative path resolves', () => {
		const { git, server, a } = two();
		a.addBlob('notes/photos/beach.jpg', 'ab12', 2481220);
		server.checkpoint();
		expect(file(git, 'notes/photos/beach.jpg')).toBe(
			'version https://git-lfs.github.com/spec/v1\noid sha256:ab12\nsize 2481220\n',
		);
		const resolve = (note, rel) =>
			new URL(rel, `file:///${note}`).pathname.slice(1);
		expect(
			a.state().blobs.get(resolve('notes/trip.md', './photos/beach.jpg')),
		).toEqual({ oid: 'ab12', size: 2481220 });
		expect(
			new Agent(git, server)
				.pull()
				.edit('notes/trip.md', (t) => t + '![](./photos/beach.jpg)\n')
				.push().accepted,
		).toBe(true);
	});
	test('an idempotent migration run by two devices at once converges; a non-idempotent one does not', () => {
		const { a, b } = two();
		const { id } = a.rowAt('notes/ideas.md');
		a.setField(id, 'due', '2026-11-01');
		const migrate = (d) => {
			const f = d.node(id).get(0);
			const v = f.getAttrs();
			if ('due' in v && !('dueDate' in v)) {
				d.doc.transact(() => {
					f.setAttr('dueDate', v.due);
					f.deleteAttr('due');
				});
			}
		};
		a.disconnect();
		b.disconnect();
		migrate(a);
		migrate(b);
		a.connect();
		b.connect();
		expect(a.state().rows.get(id).fields).toEqual({
			title: 'Ideas',
			pinned: true,
			dueDate: '2026-11-01',
		});
		const tag = (d) => d.body(id).insert(d.body(id).length, 'migrated\n');
		a.disconnect();
		b.disconnect();
		tag(a);
		tag(b);
		a.connect();
		b.connect();
		expect(
			a
				.state()
				.rows.get(id)
				.body.match(/migrated/g).length,
		).toBe(2);
	});
});
