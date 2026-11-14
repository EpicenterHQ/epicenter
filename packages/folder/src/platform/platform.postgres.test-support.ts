/**
 * People and computers for the platform's end-to-end tests: each computer an
 * Epicenter folder in a scratch home in Bun, and every person signed in to
 * the real server (`startRepositoryServer`) as the CLI is, reaching every
 * folder they hold.
 */

import { expect } from 'bun:test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import type { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { epicenterRoot, type StatIdentity } from '../device/node-root.js';
import { scratch } from '../scratch.test-support.js';
import type { KnownApp } from './apps.js';
import { identify } from './identify.js';
import { type Answer, type FolderSync, syncFolder } from './sync-folder.js';

type Server = Awaited<ReturnType<typeof startRepositoryServer>>;
export type Account = Awaited<ReturnType<Server['signIn']>>;

export const note = (title: string, body = '') =>
	`---\ntitle: ${JSON.stringify(title)}\n---\n${body}`;

/** An `epicenter.json` titled `title`, with no collections. */
export const contract = (title: string) =>
	`${JSON.stringify({ title, collections: {} })}\n`;

/** The scratch directories made, for `cleanUp`. */
const made: string[] = [];

export async function cleanUp() {
	for (const root of made.splice(0))
		await rm(root, { recursive: true, force: true });
}

/**
 * Identities a test chooses for some directories, by name, over the real
 * ones: a file system that records no birth time, or that reuses an inode.
 */
export function statSeam() {
	const chosen = new Map<string, { ino: bigint; birthtimeNs: bigint }>();
	const read: StatIdentity = async (path) => {
		const real = await stat(path, { bigint: true });
		return (
			chosen.get(basename(path)) ?? {
				ino: real.ino,
				birthtimeNs: real.birthtimeNs,
			}
		);
	};
	return { read, chosen };
}

/** One computer of `account`'s person: an Epicenter folder of its own. */
export async function computer(
	account: Account,
	label: string,
	{ stat: read, under = '' }: { stat?: StatIdentity; under?: string } = {},
) {
	const home = await scratch(`epicenter-${label}-`);
	made.push(home);
	const path = join(home, under, 'Epicenter');
	await mkdir(path, { recursive: true });
	const root = epicenterRoot(path, { stat: read });
	return {
		account,
		home,
		path,
		root,
		/** Write `files` (path to text) into the folder `name`, made when missing. */
		async write(name: string, files: Record<string, string>) {
			for (const [file, text] of Object.entries(files)) {
				await mkdir(join(path, name, file, '..'), { recursive: true });
				await writeFile(join(path, name, file), text);
			}
		},
		/** Sync the folder `name` as the person asked. */
		sync(
			name: string,
			options: {
				answer?: Answer;
				deletions?: 'push' | 'restore';
				apps?: KnownApp[];
			} = {},
		) {
			return syncFolder({ account, root, name, ...options });
		},
		/** The folder id the directory `name` is bound to here, or null. */
		async boundTo(name: string) {
			const found = expectOk(await identify({ root, account }));
			return (
				found.bound.find(({ local }) => local.name === name)?.record.folder ??
				null
			);
		},
	};
}

export type Computer = Awaited<ReturnType<typeof computer>>;

/** A person signed in to `server`, with a first computer. */
export async function person(server: Server, label: string) {
	const account = await server.signIn(label);
	return { account, desk: await computer(account, label) };
}

/** `result` as a sync that ran, or the test fails. */
export function synced(result: Awaited<ReturnType<typeof syncFolder>>) {
	const done = expectOk(result) as FolderSync;
	if (done.kind !== 'synced')
		throw new Error(`expected a sync, got ${JSON.stringify(done)}`);
	expect(done.report.outcome).toBe('synced');
	return done;
}
