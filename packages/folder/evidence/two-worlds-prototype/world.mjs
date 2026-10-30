// PROTOTYPE (throwaway): an in-process stand-in for the per-repository server object, Git, devices and an agent.
// No network, no Cloudflare. Message delivery is synchronous unless a device holds its outbox.
import * as Y from '@y/y';
import {
	fileKey,
	identity,
	merge3File,
	merge3Files,
	readFiles,
	sameFiles,
	seededDoc,
	writeFile,
	writeFiles,
} from './core.mjs';

const sha = (s) =>
	new Bun.CryptoHasher('sha1').update(s).digest('hex').slice(0, 12);
const snapshot = (files) =>
	JSON.stringify(
		[...files]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([p, f]) => [p, fileKey(f)]),
	);

export class Git {
	commits = new Map();
	main = null;
	constructor(files) {
		this.main = this.commit(files, [], 'init');
	}
	commit(files, parents, message) {
		const oid = sha(snapshot(files) + parents.join(',') + message);
		this.commits.set(oid, { files: new Map(files), parents, message });
		return oid;
	}
	files(oid) {
		return new Map(this.commits.get(oid).files);
	}
	log() {
		const out = [];
		for (let o = this.main; o; o = this.commits.get(o).parents[0])
			out.push({ oid: o, ...this.commits.get(o) });
		return out;
	}
}

export class Server {
	sockets = new Set();
	doc = null;
	alarm = false;
	stats = { checkpoints: 0, epochs: 0, filesServed: 0 };
	constructor(repo, git) {
		this.repo = repo;
		this.git = git;
		this.epoch = git.main;
	}
	live() {
		if (!this.doc) {
			this.doc = seededDoc(
				identity(this.repo, this.epoch),
				this.git.files(this.epoch),
			);
			this.doc.on('updateV2', (u, origin) => {
				if (origin !== 'remote') for (const s of this.sockets) s.deliver(u);
			});
		}
		return this.doc;
	}
	/** Handshake. A device on another epoch is told the epoch and the content hash of each file. */
	connect(device, epoch, sv) {
		this.alarm = false;
		this.sockets.add(device);
		if (epoch !== this.epoch)
			return {
				epoch: this.epoch,
				hashes: new Map(
					[...this.git.files(this.epoch)].map(([p, f]) => [p, sha(fileKey(f))]),
				),
			};
		const doc = this.live();
		return {
			epoch,
			update: Y.encodeStateAsUpdateV2(doc, sv),
			sv: Y.encodeStateVector(doc),
		};
	}
	fetch(epoch, paths) {
		const files = this.git.files(epoch);
		this.stats.filesServed += paths.length;
		return new Map(paths.map((p) => [p, files.get(p)]));
	}
	receive(from, update) {
		Y.applyUpdateV2(this.live(), update, 'remote');
		for (const s of this.sockets) if (s !== from) s.deliver(update);
	}
	disconnect(device) {
		this.sockets.delete(device);
		if (this.sockets.size === 0) {
			this.checkpoint('quiet');
			this.alarm = true;
		}
	}
	checkpoint(message = 'checkpoint') {
		if (!this.doc) return this.git.main;
		const files = readFiles(this.doc);
		if (!sameFiles(files, this.git.files(this.git.main))) {
			this.git.main = this.git.commit(files, [this.git.main], message);
			this.stats.checkpoints++;
		}
		return this.git.main;
	}
	/** The alarm: still quiet, so the epoch becomes the latest commit and the Yjs state is deleted. */
	fireAlarm() {
		if (!this.alarm || this.sockets.size) return false;
		this.checkpoint();
		this.epoch = this.git.main;
		this.doc = null;
		this.alarm = false;
		this.stats.epochs++;
		return true;
	}
	/** A push to main: checkpoint the live doc as P, merge A with P against A's parent, apply into the live doc. */
	push(oid) {
		const pushed = this.git.commits.get(oid),
			base = pushed.parents[0],
			P = this.checkpoint('before push');
		if (base === P) {
			const doc = this.live();
			writeFiles(doc, readFiles(doc), pushed.files);
			this.git.main = oid;
			return { accepted: true, fastForward: true };
		}
		const merged = merge3Files(
			this.git.files(base),
			pushed.files,
			this.git.files(P),
			'reject',
		);
		if (merged.conflict)
			return {
				accepted: false,
				reason: `main moved; ${merged.path} conflicts. Pull and merge.`,
			};
		const doc = this.live();
		writeFiles(doc, readFiles(doc), merged.files);
		this.git.main = this.git.commit(merged.files, [P, oid], `merge ${oid}`);
		return { accepted: true, fastForward: false };
	}
}

export class Device {
	doc = null;
	epoch = null;
	lastSynced = new Map();
	online = false;
	held = null;
	stats = { switches: 0, fetched: 0, seedBytesReceived: 0, carried: 0 };
	constructor(name, server) {
		this.name = name;
		this.server = server;
	}
	attach() {
		this.doc.on('updateV2', (u, origin) => {
			if (origin === 'remote' || origin === 'seed') return;
			if (!this.online) return;
			if (this.held) this.held.push(u);
			else {
				this.server.receive(this, u);
				this.synced();
			}
		});
	}
	synced() {
		if (this.online && !this.held) this.lastSynced = readFiles(this.doc);
	}
	connect() {
		let r = this.server.connect(
			this,
			this.epoch,
			this.doc ? Y.encodeStateVector(this.doc) : new Uint8Array([0]),
		);
		if (r.epoch !== this.epoch) {
			this.switchTo(r);
			r = this.server.connect(this, this.epoch, Y.encodeStateVector(this.doc));
			this.stats.seedBytesReceived += r.update.byteLength;
		}
		Y.applyUpdateV2(this.doc, r.update, 'remote');
		this.server.receive(this, Y.encodeStateAsUpdateV2(this.doc, r.sv));
		this.online = true;
		this.synced();
	}
	/** One algorithm for every epoch change: seed locally, then carry over edits made since the last sync. */
	switchTo({ epoch, hashes }) {
		const base = this.lastSynced,
			mine = this.doc ? readFiles(this.doc) : new Map(),
			theirs = new Map(),
			need = [];
		for (const [p, h] of hashes) {
			const b = base.get(p);
			if (b && sha(fileKey(b)) === h) theirs.set(p, b);
			else need.push(p);
		}
		for (const [p, f] of this.server.fetch(epoch, need)) theirs.set(p, f);
		this.stats.fetched += need.length;
		this.doc = seededDoc(identity(this.server.repo, epoch), theirs);
		this.epoch = epoch;
		this.stats.switches++;
		for (const p of new Set([...base.keys(), ...mine.keys()])) {
			if (fileKey(mine.get(p)) === fileKey(base.get(p))) continue;
			const r = merge3File(
				base.get(p),
				mine.get(p),
				theirs.get(p),
				'keep-both',
			);
			writeFile(this.doc, p, r.file);
			this.stats.carried++;
		}
		this.attach();
	}
	disconnect() {
		this.online = false;
		this.server.disconnect(this);
	}
	deliver(u) {
		if (!this.online) return;
		Y.applyUpdateV2(this.doc, u, 'remote');
		this.synced();
	}
	hold() {
		this.held = [];
	}
	release() {
		const h = this.held;
		this.held = null;
		for (const u of h) this.server.receive(this, u);
		this.synced();
	}
	files() {
		return readFiles(this.doc);
	}
	edit(path, change) {
		const f = this.files().get(path);
		writeFile(this.doc, path, change(f));
	}
}

export class Agent {
	constructor(git, server) {
		this.git = git;
		this.server = server;
	}
	pull() {
		this.base = this.git.main;
		this.files = this.git.files(this.base);
		return this;
	}
	edit(path, change) {
		this.files.set(path, change(this.files.get(path)));
		return this;
	}
	push(message) {
		const oid = this.git.commit(this.files, [this.base], message);
		return this.server.push(oid);
	}
	/** What an agent does after a rejected push: pull, merge its change onto the new main, push again. */
	rebase(path, change) {
		this.pull();
		return this.edit(path, change);
	}
}
