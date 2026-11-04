/**
 * `epicenter native-host`: the engine as a Chrome native messaging host
 * (spike). A browser extension saves tabs into the Tabs folder on this
 * computer, offline, and reads them back, through the engine instead of
 * through its own storage.
 *
 * Chrome starts the host with the caller's origin as its first argument
 * (`chrome-extension://<id>/`, and on Windows `--parent-window=<handle>`)
 * and speaks to it on stdin and stdout: each message is a 32-bit length in
 * native byte order, then that many bytes of UTF-8 JSON. Every platform
 * Epicenter ships on is little-endian. A message to the browser may be at
 * most 1 MB. `chrome.runtime.sendNativeMessage` starts one host per message
 * and reads only the first answer; `connectNative` keeps one running until
 * the port closes, so the host answers each message until stdin ends.
 *
 * ```txt
 * { op: 'save', item: { url, title, savedAt? } }  ->  { ok: true, item }
 * { op: 'list' }                        ->  { ok: true, items, invalid }
 * { op: 'sync' }                        ->  { ok: true, sync } | { ok: false, error: 'not synced' }
 * ```
 *
 * Stdout carries only frames; anything for a person goes to stderr.
 */

import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
	hostFromSiteUrl,
	relativeFolderPath,
} from '@epicenter/constants/app-names';
import { defineContract } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { openDevice } from '@epicenter/folder/node';
import { resolveAppPaths } from './app-paths.ts';
import type { GrantKind } from './auth.ts';
import { EXIT, writeErr } from './output.ts';
import type { CredentialFor } from './sync/git.ts';

/** The name an extension passes to `sendNativeMessage` and `connectNative`. */
export const NATIVE_HOST_NAME = 'so.epicenter.engine';

/** Placeholder site for the Tabs app; its folder is `<library>/tabs`. */
export const TABS_SITE = 'https://tabs.epicenter.so';

export const tabsContract = defineContract({
	description: 'Tabs saved from a browser.',
	collections: {
		tabs: {
			path: 'tabs/{id}.md',
			fields: {
				url: { type: 'string' },
				title: { type: 'string' },
				savedAt: { type: 'string' },
			},
			required: ['url', 'savedAt'],
		},
	},
});

/** The largest message Chrome accepts from a host. */
export const MAX_HOST_MESSAGE = 1024 * 1024;
/** The largest message Chrome sends a host (64 MiB). */
const MAX_BROWSER_MESSAGE = 64 * 1024 * 1024;

/** Tabs's data folder in this environment's library. */
export function tabsFolder(folderDir = resolveAppPaths().folderDir): string {
	return join(folderDir, relativeFolderPath(hostFromSiteUrl(TABS_SITE)));
}

/** `value` as one frame: a little-endian length, then UTF-8 JSON. */
export function encodeMessage(value: unknown): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(value));
	const frame = new Uint8Array(4 + body.length);
	new DataView(frame.buffer).setUint32(0, body.length, true);
	frame.set(body, 4);
	return frame;
}

/**
 * Each message in `source`, a byte stream cut anywhere. Ends when the
 * stream ends between frames; throws when it ends inside one or a frame
 * claims more than Chrome would send.
 */
export async function* readMessages(
	source: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
	let buffered = new Uint8Array(0);
	for await (const chunk of source) {
		const joined = new Uint8Array(buffered.length + chunk.length);
		joined.set(buffered);
		joined.set(chunk, buffered.length);
		buffered = joined;
		while (buffered.length >= 4) {
			const length = new DataView(
				buffered.buffer,
				buffered.byteOffset,
			).getUint32(0, true);
			if (length > MAX_BROWSER_MESSAGE)
				throw new Error(`A message claims ${length} bytes.`);
			if (buffered.length < 4 + length) break;
			const body = buffered.subarray(4, 4 + length);
			buffered = buffered.slice(4 + length);
			yield JSON.parse(new TextDecoder().decode(body));
		}
	}
	if (buffered.length > 0) throw new Error('Stdin ended inside a message.');
}

export type HostAnswer =
	| { ok: true; [key: string]: unknown }
	| { ok: false; error: string; [key: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Answers one message at a time over the Tabs folder at `folder`. `sync`
 * runs one round only when the folder is its own synced repository.
 */
export function createTabsHost({
	folder,
	credential,
	now = () => new Date(),
}: {
	folder: string;
	credential?: CredentialFor;
	now?: () => Date;
}) {
	let opened: ReturnType<typeof openDevice<typeof tabsContract>> | undefined;
	const device = async () => {
		opened ??= openDevice(tabsContract, { path: folder });
		const { data, error } = await opened;
		if (error !== null) throw new Error(error.message);
		return data;
	};

	return async function answer(message: unknown): Promise<HostAnswer> {
		if (!isRecord(message)) return { ok: false, error: 'not an object' };
		switch (message.op) {
			case 'save': {
				const item = message.item;
				if (
					!isRecord(item) ||
					typeof item.url !== 'string' ||
					(item.title !== undefined && typeof item.title !== 'string') ||
					(item.savedAt !== undefined &&
						Number.isNaN(Date.parse(String(item.savedAt))))
				)
					return {
						ok: false,
						error:
							'save needs item.url; title and savedAt are optional strings',
					};
				const tabs = (await device()).tabs;
				// A save the extension kept while no host answered carries its moment.
				const at =
					typeof item.savedAt === 'string' ? new Date(item.savedAt) : now();
				const created = await tabs.create({
					id: timeId(at),
					url: item.url,
					title: item.title ?? '',
					savedAt: at.toISOString(),
				});
				if (created.error !== null)
					return { ok: false, error: created.error.message };
				const { id, url, title, savedAt } = created.data;
				return { ok: true, item: { id, url, title, savedAt } };
			}
			case 'list': {
				const listed = await (await device()).tabs.list();
				if (listed.error !== null)
					return { ok: false, error: listed.error.message };
				return {
					ok: true,
					items: listed.data.items.map(({ id, url, title, savedAt }) => ({
						id,
						url,
						title,
						savedAt,
					})),
					invalid: listed.data.invalid.map(({ id }) => id),
				};
			}
			case 'sync': {
				const [{ git }, { syncFolder }] = await Promise.all([
					import('./sync/git.ts'),
					import('./sync/sync.ts'),
				]);
				const notSynced = { ok: false, error: 'not synced', folder } as const;
				const real = await realpath(folder).catch(() => null);
				if (real === null) return notSynced;
				const top = await git(folder, ['rev-parse', '--show-toplevel']);
				const synced = await git(folder, [
					'config',
					'--local',
					'--get',
					'epicenter.synced',
				]);
				if (
					top.code !== 0 ||
					top.stdout.trim() !== real ||
					synced.stdout.trim() !== 'true'
				)
					return notSynced;
				const result = await syncFolder(folder, { credential });
				return result.status === 'synced'
					? { ok: true, sync: result }
					: { ok: false, error: result.message ?? result.status, sync: result };
			}
			default:
				return { ok: false, error: `unknown op ${JSON.stringify(message.op)}` };
		}
	};
}

/** Write one frame, refusing an answer over Chrome's limit, and wait for it to drain. */
function send(write: (bytes: Uint8Array) => Promise<void>, value: unknown) {
	let frame = encodeMessage(value);
	if (frame.length - 4 > MAX_HOST_MESSAGE)
		frame = encodeMessage({
			ok: false,
			error: `the answer is ${frame.length - 4} bytes; Chrome takes at most ${MAX_HOST_MESSAGE}`,
		});
	return write(frame);
}

/**
 * Answer every message from `input` on `write` until `input` ends. A
 * message that throws is answered `{ ok: false }`; a broken frame ends the
 * host.
 */
export async function serve(
	input: AsyncIterable<Uint8Array>,
	write: (bytes: Uint8Array) => Promise<void>,
	answer: (message: unknown) => Promise<HostAnswer>,
) {
	for await (const message of readMessages(input)) {
		const reply = await answer(message).catch(
			(error: unknown): HostAnswer => ({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		await send(write, reply);
	}
}

/** `epicenter native-host [<origin>]`, as Chrome runs it. */
export async function nativeHostCommand(
	origin: string | undefined,
	grant: GrantKind,
): Promise<number> {
	const credential: CredentialFor = async (url) => {
		const [{ authContext }, { hostedCredentials }] = await Promise.all([
			import('./auth.ts'),
			import('./repository-commands.ts'),
		]);
		return hostedCredentials(authContext(), grant)(url);
	};
	const answer = createTabsHost({ folder: tabsFolder(), credential });
	const write = (bytes: Uint8Array) =>
		new Promise<void>((done, fail) =>
			process.stdout.write(bytes, (error) => (error ? fail(error) : done())),
		);
	try {
		await serve(process.stdin, write, answer);
		return EXIT.ok;
	} catch (error) {
		writeErr(
			`epicenter native-host (${origin ?? 'no origin'}): ${error instanceof Error ? error.message : String(error)}`,
		);
		return EXIT.unusable;
	}
}
