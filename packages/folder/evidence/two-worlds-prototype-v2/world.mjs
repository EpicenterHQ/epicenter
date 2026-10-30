// PROTOTYPE v2 (throwaway): server object with a permanent document, devices, an agent editing Markdown text.
import * as Y from '@y/y';
import {
	materialize,
	mergeStates,
	parseTree,
	readState,
	writeState,
} from './core.mjs';

const sha = (s) =>
	new Bun.CryptoHasher('sha1').update(s).digest('hex').slice(0, 12);
const tree = (files) =>
	JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
const sameTree = (a, b) => tree(a) === tree(b);

export class Git {
	commits = new Map();
	main = null;
	constructor(files) {
		this.main = this.commit(files, [], 'init');
	}
	commit(files, parents, message) {
		const oid = sha(tree(files) + parents.join(',') + message);
		this.commits.set(oid, { files: new Map(files), parents, message });
		return oid;
	}
	files(oid = this.main) {
		return new Map(this.commits.get(oid).files);
	}
}

export class Server {
	sockets = new Set();
	stats = { commits: 0 };
	constructor(git) {
		this.git = git;
		this.doc = new Y.Doc();
		const parsed = parseTree(git.files());
		this.outside = parsed.outside;
		writeState(this.doc, parsed);
		this.doc.on('updateV2', (u, origin) => {
			if (origin !== 'remote') for (const s of this.sockets) s.deliver(u);
		});
		this.checkpoint('assign ids'); // the first checkpoint writes the ids the parse assigned
	}
	connect(device, sv) {
		this.sockets.add(device);
		return {
			update: Y.encodeStateAsUpdateV2(this.doc, sv),
			sv: Y.encodeStateVector(this.doc),
		};
	}
	receive(from, u) {
		Y.applyUpdateV2(this.doc, u, 'remote');
		for (const s of this.sockets) if (s !== from) s.deliver(u);
	}
	disconnect(device) {
		this.sockets.delete(device);
		if (!this.sockets.size) this.checkpoint('last device left');
	}
	checkpoint(message = 'checkpoint') {
		const files = materialize(readState(this.doc), this.outside);
		if (!sameTree(files, this.git.files())) {
			this.git.main = this.git.commit(files, [this.git.main], message);
			this.stats.commits++;
		}
		return this.git.main;
	}
	/** A push: checkpoint as P, merge the pushed tree A with P against A's parent B, structurally, by stable id. */
	push(oid) {
		const pushed = this.git.commits.get(oid),
			Bfiles = this.git.files(pushed.parents[0]);
		const P = this.checkpoint('before push'),
			Pstate = { ...readState(this.doc), outside: this.outside };
		const B = parseTree(Bfiles, Pstate),
			A = parseTree(pushed.files, B);
		const merged = mergeStates(B, A, Pstate);
		if (merged.conflict)
			return {
				accepted: false,
				reason: `main moved; ${merged.conflict} conflicts. Pull and merge.`,
			};
		writeState(this.doc, merged.state);
		this.outside = merged.outside;
		const files = materialize(readState(this.doc), this.outside);
		this.git.main = this.git.commit(files, [P, oid], `merge ${oid}`);
		return { accepted: true, newIdsWritten: !sameTree(files, pushed.files) };
	}
}

export class Device {
	doc = new Y.Doc();
	online = false;
	held = null;
	constructor(name, server) {
		this.name = name;
		this.server = server;
		this.doc.on('updateV2', (u, origin) => {
			if (origin === 'remote' || !this.online) return;
			if (this.held) this.held.push(u);
			else this.server.receive(this, u);
		});
	}
	connect() {
		const r = this.server.connect(this, Y.encodeStateVector(this.doc));
		Y.applyUpdateV2(this.doc, r.update, 'remote');
		this.online = true;
		this.server.receive(this, Y.encodeStateAsUpdateV2(this.doc, r.sv));
	}
	disconnect() {
		this.online = false;
		this.server.disconnect(this);
	}
	deliver(u) {
		if (this.online) Y.applyUpdateV2(this.doc, u, 'remote');
	}
	hold() {
		this.held = [];
	}
	release() {
		const h = this.held;
		this.held = null;
		for (const u of h) this.server.receive(this, u);
	}
	state() {
		return readState(this.doc);
	}
	rowAt(path) {
		for (const [id, r] of this.state().rows)
			if (r.path === path) return { id, ...r };
	}
	node(id) {
		return this.doc.get('rows').getAttr(id);
	}
	body(id) {
		return this.node(id).get(1);
	}
	setField(id, k, v) {
		this.node(id).get(0).setAttr(k, v);
	}
	rename(id, path) {
		this.node(id).setAttr('path', path);
	}
	setKv(k, v) {
		this.doc.get('kv').setAttr(k, v);
	}
	declareOrder(table, keys) {
		this.doc.get('meta').setAttr(`order:${table}`, keys);
	}
	addBlob(path, oid, size) {
		this.doc.get('blobs').setAttr(path, { oid, size });
	}
}

/** An agent in a clone: edits Markdown text, renames and copies files, pushes. */
export class Agent {
	constructor(git, server) {
		this.git = git;
		this.server = server;
	}
	pull() {
		this.base = this.git.main;
		this.files = this.git.files();
		return this;
	}
	edit(path, f) {
		this.files.set(path, f(this.files.get(path)));
		return this;
	}
	move(from, to) {
		this.files.set(to, this.files.get(from));
		this.files.delete(from);
		return this;
	}
	copy(from, to) {
		this.files.set(to, this.files.get(from));
		return this;
	}
	write(path, text) {
		this.files.set(path, text);
		return this;
	}
	push(message = 'agent') {
		return this.server.push(this.git.commit(this.files, [this.base], message));
	}
}
