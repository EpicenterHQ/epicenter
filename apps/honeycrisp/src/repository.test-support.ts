/**
 * Honeycrisp's repository in a test: the repository API over a replica in
 * this process, on `bun:sqlite`, with no server. The device starts with
 * `files`, exactly as their text reads; `theirs` writes a change the way
 * another program on this device would, straight into the replica; and
 * every `tab()` is another repository over the same replica, which stands
 * in for a change made elsewhere on this device.
 */
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica, type Replica } from '@epicenter/repository/client';
import { unwrap } from 'wellcrafted/result';
import { createLocalHost } from '../../../packages/repository/src/api/local.js';
import { openRepository } from '../../../packages/repository/src/api/repository.js';
import { honeycrispApp } from './data.js';
import type { HoneycrispRepository } from './repository.js';

export async function openDevice(files: Record<string, string> = {}) {
	const driver = openBunSqlite();
	const replica = unwrap(openReplica({ driver, binding: { repository: 'honeycrisp', server: null, account: null }, device: 'this-device', app: honeycrispApp, after: () => {}, now: () => 0 }));
	for (const [path, text] of Object.entries(files)) replica.write(path, text);
	/** When set, the replica refuses every change, as a full disk would. */
	let refuse = false;
	const refusing: Replica = {
		...replica,
		change(changes) {
			if (refuse) throw new Error('the disk is full');
			return replica.change(changes);
		},
	};
	const opened: HoneycrispRepository[] = [];
	const open = (over: Replica): HoneycrispRepository => {
		const repository = openRepository({ app: honeycrispApp, host: createLocalHost({ replica: over, app: honeycrispApp }).host });
		opened.push(repository);
		return repository;
	};
	return {
		/** A repository over this device's replica, whose writes `refuseWrites` refuses, as the page would be given. */
		open: () => open(refusing),
		/** Another repository over this device's replica. */
		tab: () => open(replica),
		/** The file's text as this device holds it. */
		text: (path: string) => replica.read(path),
		/** Another program on this device writes `path`. */
		theirs(path: string, text: string | null) {
			replica.write(path, text);
		},
		refuseWrites(value: boolean) {
			refuse = value;
		},
		close() {
			for (const repository of opened.splice(0)) repository.close();
			replica.close();
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
