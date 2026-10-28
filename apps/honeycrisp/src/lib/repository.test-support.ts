/**
 * Honeycrisp's repository in a test: the real engine on `bun:sqlite`, with a
 * scripted server behind it. The server starts the device with `files`,
 * exactly as their text reads, and `theirs` delivers a change another device
 * made. It answers no batch, so this device's writes wait in its outbox, as
 * they do offline. Every `tab()` is another client of the one engine, which
 * stands in for a change made elsewhere on this device.
 */
import { createRepository, type EnginePort, openEngine, type Transport, TransportError, WriteError } from '@epicenter/repository';
import { openBunSqlite } from '@epicenter/repository/bun';
import { Ok } from 'wellcrafted/result';
import { honeycrispApp } from './data.js';
import type { HoneycrispRepository, HoneycrispTab } from './repository.js';

/** A tab that owns `repository`, as the browser host reports one. */
export function owningTab(repository: HoneycrispRepository): HoneycrispTab {
	const state = { status: 'open', repository } as const;
	return {
		state: () => state,
		subscribe(onChange) {
			onChange(state);
			return () => {};
		},
		close() {},
	};
}

export async function openDevice(files: Record<string, string> = {}) {
	let deliver: Parameters<Transport['connect']>[0]['onBroadcast'] | undefined;
	let seq = 1;
	const state = (path: string, text: string | null) => ({ path, text, hash: text === null ? null : `hash-${seq}` });
	const transport: Transport = {
		connect(handlers) {
			deliver = handlers.onBroadcast;
			return {
				connected: () => false,
				hello: async () => Ok({ kind: 'snapshot' as const, seq: 1, files: Object.entries(files).map(([path, text]) => state(path, text)) }),
				push: async () => TransportError.Offline({ sent: false }),
				close() {},
			};
		},
	};
	const driver = openBunSqlite();
	const engine = openEngine({ app: honeycrispApp, driver, transport, device: 'this-device' });
	/** When set, the engine refuses every write, as a full disk would. */
	let refuse = false;
	const port: EnginePort = {
		read: (request) => engine.read(request),
		submit(ops) {
			if (!refuse) return engine.submit(ops);
			const failed = WriteError.Unparseable({ path: 'notes/', reason: 'the disk is full' });
			return { local: Promise.resolve(failed), settled: Promise.resolve(failed) };
		},
		send: (ops) => engine.send(ops),
		onChange: (listener) => engine.onChange(listener),
		// A client closing leaves the engine to the others.
		close() {},
	};
	const first = createRepository(honeycrispApp, port);
	await first.flush();
	return {
		repo: first,
		/** Another client of this device's engine. */
		tab: (): HoneycrispRepository => createRepository(honeycrispApp, port),
		/** The file's text as this device holds it, read from SQLite itself. */
		text: (path: string) =>
			driver.all<{ text: string | null }>('SELECT text FROM "epicenter/files" WHERE path = ?', [path])[0]?.text ?? null,
		/** Another device's change arrives, as the server broadcasts it. */
		async theirs(path: string, text: string | null) {
			seq++;
			deliver?.({ seq, device: 'other-device', files: [state(path, text)], moves: [] });
			await first.flush();
		},
		refuseWrites(value: boolean) {
			refuse = value;
		},
		close() {
			engine.close();
			driver.close();
		},
	};
}
export type Device = Awaited<ReturnType<typeof openDevice>>;

/** A note's text in Honeycrisp's form, with a key Honeycrisp does not name. */
export function noteText({
	title = 'A',
	body = 'Body.\n',
	extra = 'owner:\n  name: one\n  tags: [two]\n',
	folderId = 'null',
	pinned = 'false',
}: {
	title?: string;
	body?: string;
	extra?: string;
	folderId?: string;
	pinned?: string;
} = {}) {
	return [
		'---',
		`folderId: ${folderId}`,
		`title: ${JSON.stringify(title)}`,
		`pinned: ${pinned}`,
		'createdAt: "2026-10-01T00:00:00.000Z"',
		'deletedAt: null',
		`${extra}---`,
		body,
	].join('\n');
}

/** A folder's text in Honeycrisp's form. */
export const folderText = (name: string) => `---\nname: ${JSON.stringify(name)}\nicon: null\n---\n`;

/** Poll `check`, running `flush` (such as Svelte's `flushSync`) first, until it holds. */
export async function until(check: () => boolean, what: string, flush: () => void = () => {}) {
	for (let tries = 0; tries < 400; tries++) {
		flush();
		try {
			if (check()) return;
		} catch {}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}
