/**
 * The Playwright side of an app's end-to-end suite, over the environment
 * `app-stack.test-support.ts` starts: the global setup that runs the
 * app's `e2e/stack.ts` for the whole run, a `test` whose worker fixtures
 * are the stack and the project's person, the `epicenter` command in that
 * person's desktop sandbox, and a look at the browser's private files.
 *
 * Runs under Playwright's Node runner, so it imports nothing Bun-only.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BrowserContext,
	test as base,
	expect,
	type Page,
	type Route,
} from 'playwright/test';
import type { Person, Stack } from './app-stack.test-support.ts';

export type { Person, Stack };

/**
 * A Playwright `globalSetup` that starts `stackScript` (Bun) for the whole
 * run and stops it after; the tests find what it started in the file the
 * environment variable `stateVariable` names.
 */
export function stackGlobalSetup(stackScript: string, stateVariable: string) {
	return async function globalSetup() {
		const directory = mkdtempSync(join(tmpdir(), 'e2e-state-'));
		const state = join(directory, 'stack.json');
		const stack = spawn('bun', ['--no-install', stackScript, state], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		await new Promise<void>((ready, failed) => {
			let output = '';
			stack.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes('ready')) ready();
			});
			stack.on('exit', (code) =>
				failed(new Error(`The e2e stack exited ${code} before it was ready`)),
			);
		});
		process.env[stateVariable] = state;
		return async () => {
			stack.kill('SIGTERM');
			await new Promise((done) => stack.once('exit', done));
			await rm(directory, { recursive: true, force: true });
		};
	};
}

/** Playwright's `test` with the stack and this project's person as worker fixtures. */
export function stackTest(stateVariable: string) {
	return base.extend<object, { stack: Stack; person: Person }>({
		stack: [
			// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern.
			async ({}, use) => {
				const state = process.env[stateVariable];
				if (!state) throw new Error('globalSetup did not start the stack');
				await use(JSON.parse(await readFile(state, 'utf8')) as Stack);
			},
			{ scope: 'worker' },
		],
		person: [
			async ({ stack }, use, workerInfo) => {
				const person = stack.people[workerInfo.project.name];
				if (!person)
					throw new Error(`no person for ${workerInfo.project.name}`);
				await use(person);
			},
			{ scope: 'worker' },
		],
	});
}

export function run(
	command: string[],
	{ cwd, env }: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(command[0] as string, command.slice(1), { cwd, env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk;
		});
		child.on('close', (code) => done({ code, stdout, stderr }));
	});
}

/** The `epicenter` command from this checkout, in the person's desktop sandbox. */
export function epicenter(stack: Stack, person: Person, ...args: string[]) {
	return run([stack.bun, '--no-install', stack.cli, ...args], {
		cwd: person.home,
		env: person.env,
	});
}

/** `epicenter sync` until it has synced; exit 1 means run again. */
export async function sync(stack: Stack, person: Person, folder: string) {
	for (let round = 1; ; round++) {
		const synced = await epicenter(stack, person, 'sync', folder);
		if (synced.code !== 1 || round === 5) {
			expect(synced.code, `${synced.stdout}\n${synced.stderr}`).toBe(0);
			return;
		}
	}
}

/**
 * Every file in the page origin's OPFS but the device's staging area, by
 * path, as sha256. A file the page moves or removes during the walk is not
 * listed; a file a write lands on while it is read is read again.
 */
export function opfsFiles(page: Page): Promise<Record<string, string>> {
	return page.evaluate(digestTree, undefined);
}

/**
 * Every file under `root` (the origin's OPFS when omitted) but the device's
 * staging area, by path, as sha256: `opfsFiles` in the page.
 *
 * The page's own writes run beside the walk. A file that went between being
 * named and being read is left out. A file a write landed on between taking
 * it and reading its bytes is still there, and is read again: Chromium says
 * `NotReadableError` for that and WebKit `NotFoundError`, the same names
 * either engine gives a file that went, so only a look at the directory
 * tells them apart (the device's own `read` does the same).
 *
 * Self-contained, so Playwright can send it to the page: it names nothing
 * outside itself.
 */
export async function digestTree(
	root?: FileSystemDirectoryHandle,
): Promise<Record<string, string>> {
	type Directory = FileSystemDirectoryHandle & {
		entries(): AsyncIterable<[string, FileSystemHandle]>;
	};
	const files: Record<string, string> = {};
	/** What a read says when its file changed or went under it. */
	const unsettled = (cause: unknown) =>
		cause instanceof DOMException &&
		(cause.name === 'NotFoundError' || cause.name === 'NotReadableError');
	/** The sha256 of `name` in `directory`, or undefined when it went. */
	async function digestOf(directory: Directory, name: string) {
		for (let attempt = 1; ; attempt++) {
			try {
				const file = await (await directory.getFileHandle(name)).getFile();
				const digest = await crypto.subtle.digest(
					'SHA-256',
					await file.arrayBuffer(),
				);
				return [...new Uint8Array(digest)]
					.map((byte) => byte.toString(16).padStart(2, '0'))
					.join('');
			} catch (cause) {
				if (!unsettled(cause)) throw cause;
				const there = await directory.getFileHandle(name).then(
					() => true,
					() => false,
				);
				if (!there) return undefined;
				if (attempt === 5) throw cause;
			}
		}
	}
	async function walk(directory: Directory, prefix: string) {
		try {
			for await (const [name, handle] of directory.entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					await walk(handle as Directory, `${path}/`);
					continue;
				}
				const digest = await digestOf(directory, name);
				if (digest !== undefined) files[path] = digest;
			}
		} catch (cause) {
			// The directory itself went (its last file moved or was deleted).
			if (!unsettled(cause)) throw cause;
		}
	}
	await walk(
		(root ?? (await navigator.storage.getDirectory())) as Directory,
		'',
	);
	for (const path of Object.keys(files))
		if (path.startsWith('.epicenter/staging/')) delete files[path];
	return files;
}

/**
 * The text of the file at `path` in the page origin's OPFS, or null when
 * there is none. A file a write lands on while it is read is read again,
 * as in `digestTree`.
 */
export function opfsText(page: Page, path: string): Promise<string | null> {
	return page.evaluate(async (path) => {
		let directory = await navigator.storage.getDirectory();
		const segments = path.split('/');
		const name = segments.pop() as string;
		try {
			for (const segment of segments)
				directory = await directory.getDirectoryHandle(segment);
		} catch {
			return null;
		}
		for (let attempt = 1; ; attempt++) {
			try {
				return await (await directory.getFileHandle(name))
					.getFile()
					.then((file) => file.text());
			} catch (cause) {
				const there = await directory.getFileHandle(name).then(
					() => true,
					() => false,
				);
				if (!there) return null;
				if (attempt === 5) throw cause;
			}
		}
	}, path);
}

/**
 * Empty the page origin's OPFS. WebKit keeps OPFS outside the profile
 * directory, so an earlier run's files may still be there.
 */
export function emptyOpfs(page: Page) {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		for await (const name of (
			root as unknown as { keys(): AsyncIterable<string> }
		).keys())
			await root.removeEntry(name, { recursive: true });
	});
}

/**
 * Take the network away from every page of `context`: each http(s) request
 * fails as a disconnected one would. Answers the function that gives it
 * back.
 *
 * Not `context.setOffline(true)`: under Playwright, WebKit loads `blob:`
 * URLs, which is how a Worker reads an OPFS file's bytes, through the same
 * interception, and offline emulation (or a catch-all route) blocks them
 * ("Blocked by Web Inspector"), so local reads fail where a real offline
 * browser reads them. Only http(s) goes.
 */
export async function goOffline(context: BrowserContext) {
	const offline = (url: URL) =>
		url.protocol === 'http:' || url.protocol === 'https:';
	const disconnect = (route: Route) => route.abort('internetdisconnected');
	await context.route(offline, disconnect);
	return () => context.unroute(offline, disconnect);
}
