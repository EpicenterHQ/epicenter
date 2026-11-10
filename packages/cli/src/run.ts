/**
 * One action's run, for the command line and both MCP transports (ADR-0850).
 * The action writes through its folder as it runs. When it returns and is not
 * read-only, the run commits what changed in the app's folder as one commit
 * named for the call, however the call arrived. The answer is what the action returned, with
 * its commit, or what it threw.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { folderOnDisk } from './disk.ts';
import { commitFolder, git } from './git.ts';
import type { Runnable } from './home.ts';
import type { Answer } from './report.ts';
import { keychain, keychainService } from './secrets.ts';

/**
 * What the action threw, as the answer carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole so its name and fields reach the caller.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Record<string, unknown>;
} {
	const message = extractErrorMessage(cause);
	if (typeof cause !== 'object' || cause === null || cause instanceof Error)
		return { message };
	const { name } = cause as { name?: unknown };
	if (
		typeof name !== 'string' ||
		typeof (cause as { message?: unknown }).message !== 'string'
	)
		return { message };
	return { message, thrown: JSON.parse(JSON.stringify(cause)) };
}

/**
 * A write's commit subject: the app, the action's words, and its first
 * positional value on one line, cut at 60 characters
 * (`tasks: add Water the plants`).
 */
export function commitSubject(app: string, key: string, value: unknown) {
	const suffix =
		value === undefined
			? ''
			: ` ${typeof value === 'string' ? value : JSON.stringify(value)}`;
	return `${app}: ${key}${suffix.replace(/\s+/g, ' ').slice(0, 61)}`;
}

/** How long a write waits for another write to the same app before it throws. */
const WRITE_LOCK_WAIT_MS = 30_000;

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Hold the app's write lock until the returned function releases it. Writes
 * to one app, from the command line, stdio, or HTTP, run one at a time, so an
 * action that reads a file, changes it, and writes it back never loses
 * another's change, and each write's commit holds only its own changes. The
 * lock is a file in the temporary folder named for the app's path, holding
 * the holder's pid; a lock whose process has died is taken over.
 */
export async function holdWriteLock(folder: string): Promise<() => Promise<void>> {
	const dir = join(tmpdir(), 'epicenter-writes');
	await mkdir(dir, { recursive: true });
	const path = join(
		dir,
		`${createHash('sha256').update(folder).digest('hex').slice(0, 32)}.lock`,
	);
	const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
	for (;;) {
		try {
			await writeFile(path, String(process.pid), { flag: 'wx' });
			return () => rm(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		const holder = Number(await readFile(path, 'utf8').catch(() => ''));
		// An empty file is a holder still writing its pid: wait for it.
		if (holder > 0 && !alive(holder)) {
			await rm(path, { force: true });
			continue;
		}
		if (Date.now() > deadline)
			throw new Error(
				`Another write to this app has run for over ${WRITE_LOCK_WAIT_MS / 1000} seconds${holder > 0 ? ` (process ${holder})` : ''}`,
			);
		await Bun.sleep(20);
	}
}

/**
 * Run `action`, the app's `key`, with its checked input in the app's folder.
 * A write holds the app's write lock while it runs and commits; when it
 * returns, what changed in the folder is committed, named for the call. A
 * folder in no repository is left as it is.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
): Promise<Exclude<Answer, { error: unknown }>> {
	const readOnly = action.annotations?.readOnlyHint === true;
	let release: (() => Promise<void>) | undefined;
	try {
		if (!readOnly) release = await holdWriteLock(located.realPath);
		return await runAndCommit(located, key, action, input, readOnly);
	} catch (error) {
		return { threw: threwOf(error) };
	} finally {
		await release?.();
	}
}

async function runAndCommit(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	readOnly: boolean,
): Promise<Exclude<Answer, { error: unknown }>> {
	let returned: unknown;
	try {
		returned =
			(await action.run(input, {
				folder: folderOnDisk(located.realPath),
				secrets: keychain(keychainService(located.name)),
			})) ?? null;
	} catch (error) {
		return { threw: threwOf(error) };
	}
	if (readOnly) return { returned };
	const inside = await git(located.realPath, [
		'rev-parse',
		'--is-inside-work-tree',
	]);
	if (inside.code !== 0 || inside.stdout !== 'true') return { returned };
	try {
		const subject = commitSubject(
			located.name,
			key,
			input[action.positional?.[0] ?? ''],
		);
		if ((await commitFolder(located.realPath, subject)) === 0)
			return { returned };
		const head = await git(located.realPath, ['rev-parse', '--short', 'HEAD']);
		return { returned, committed: head.stdout };
	} catch (error) {
		return {
			returned,
			uncommitted: {
				message: extractErrorMessage(error),
				next: `epicenter sync ${located.name}`,
			},
		};
	}
}
