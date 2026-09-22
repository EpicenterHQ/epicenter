import { openSqlite } from '@epicenter/app/sqlite';
/**
 * Real desktop SQLite transport with synthetic Gmail pages. Uses temporary
 * files, the production native framing/worker, and the desktop WebSocket client.
 * Run from the repository root: bun apps/local-mail/evidence/native-storage.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopSqliteOwner } from '../../../packages/device/src/desktop.js';
import { createDeviceDispatcher } from '../../../packages/device/src/owner.js';
import {
	parseSqliteFrame,
	stringifySqliteFrame,
} from '../../../packages/device/src/protocol.js';
import { asPrincipalId } from '../../../packages/principal/src/principal.js';
import { createNativeDevice } from '../../epicenter/src/device.js';
import {
	createNativePort,
	watchParentPipe,
} from '../../epicenter/src/sidecar-runtime.js';
import { openMailbox } from '../src/mailbox.js';
import { openLocalMailStorage } from '../src/storage.js';

const build = Bun.spawn(
	[
		'cargo',
		'build',
		'--manifest-path',
		'apps/epicenter/src-tauri/Cargo.toml',
		'--example',
		'mail_storage_evidence',
	],
	{
		stdout: 'ignore',
		stderr: 'inherit',
	},
);
assert.equal(await build.exited, 0, 'native fixture must build');
const root = await mkdtemp(join(tmpdir(), 'mail-native-storage-'));
const child = Bun.spawn(
	[
		'apps/epicenter/src-tauri/target/debug/examples/mail_storage_evidence',
		root,
	],
	{
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
	},
);
// This probe has no authentication boot. Skip one inert line with the same
// framing reader the production sidecar uses, then consume real native replies.
const parentPipe = watchParentPipe(
	child.stdout.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{}\n'));
			},
		}),
	),
);
let largestNativeFrame = 0;
const native = createNativePort(
	{ parentPipe },
	{
		writeLine(line) {
			largestNativeFrame = Math.max(
				largestNativeFrame,
				Buffer.byteLength(line) + 1,
			);
			child.stdin.write(`${line}\n`);
			child.stdin.flush();
		},
	},
);
void native.completed.catch(() => {});
void parentPipe.closed.catch(() => {});
const device = createNativeDevice(native);
const dispatchers = new Set<ReturnType<typeof createDeviceDispatcher>>();
const server = Bun.serve<{
	dispatcher: ReturnType<typeof createDeviceDispatcher>;
}>({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request, server) {
		const dispatcher = createDeviceDispatcher(device);
		dispatchers.add(dispatcher);
		return server.upgrade(request, { data: { dispatcher } })
			? undefined
			: new Response(null, { status: 400 });
	},
	websocket: {
		async message(socket, bytes) {
			const frame = parseSqliteFrame(String(bytes)) as {
				id: number;
				request: Parameters<typeof socket.data.dispatcher.request>[0];
			};
			try {
				socket.send(
					stringifySqliteFrame({
						id: frame.id,
						response: await socket.data.dispatcher.request(frame.request),
					}),
				);
			} catch (cause) {
				socket.send(
					stringifySqliteFrame({
						id: frame.id,
						failure: cause instanceof Error ? cause.message : String(cause),
					}),
				);
			}
		},
		close(socket) {
			void socket.data.dispatcher.close().catch(() => {});
		},
	},
});
const owner = createDesktopSqliteOwner({ baseURL: server.url.origin });

let app = await openSqlite({ owner, id: 'so.epicenter.local-mail' });
try {
	const storage = await openLocalMailStorage({ sqlite: app });
	const mailbox = openMailbox(await storage.mail('synthetic'));
	await mailbox.ingestLabels([{ id: 'INBOX', name: 'Inbox', type: 'system' }]);
	const body = Buffer.from('Synthetic mail body. '.repeat(12_000)).toString(
		'base64',
	);
	const messages = Array.from({ length: 100 }, (_, i) => ({
		id: `m${i}`,
		threadId: `t${i}`,
		labelIds: ['INBOX'],
		internalDate: '1000',
		payload: {
			mimeType: 'text/plain',
			headers: [{ name: 'Subject', value: `Synthetic ${i}` }],
			body: { data: body },
		},
	}));
	const checkpoint = {
		scanId: 'synthetic-scan',
		historyId: '100',
		syncedAt: '2026-09-19T00:00:00.000Z',
		nextPageToken: 'second-page',
	};
	await mailbox.ingestFullPullPage(messages, checkpoint);
	assert.equal(
		(await mailbox.listMessages({ labelId: 'INBOX', limit: 100, offset: 0 }))
			.length,
		100,
	);
	assert.deepEqual(await mailbox.readFullPullCheckpoint(), checkpoint);
	assert.equal(
		(await openMailbox(await storage.mail('other')).counts()).messages,
		0,
	);
	await app.close();
	app = await openSqlite({ owner, id: 'so.epicenter.local-mail' });
	const otherAccount = await openLocalMailStorage({ sqlite: app });
	assert.equal(
		(await openMailbox(await otherAccount.mail('synthetic')).counts()).messages,
		100,
	);
	await app.close();
	app = await openSqlite({ owner, id: 'so.epicenter.local-mail' });
	const reopened = await openLocalMailStorage({ sqlite: app });
	const recovered = openMailbox(await reopened.mail('synthetic'));
	assert.equal((await recovered.counts()).messages, 100);
	assert.deepEqual(await recovered.readFullPullCheckpoint(), checkpoint);
	assert.ok(largestNativeFrame < 8 * 1024 * 1024);
	console.log(
		JSON.stringify({
			passed: true,
			messages: 100,
			reopened: true,
			isolatedMailboxes: true,
			isolatedAccounts: true,
			largestNativeFrame,
		}),
	);
} finally {
	await app.close().catch(() => {});
	await Promise.allSettled(
		[...dispatchers].map((dispatcher) => dispatcher.close()),
	);
	server.stop(true);
	child.stdin.end();
	await child.exited;
	await native.completed.catch(() => {});
	await rm(root, { recursive: true, force: true });
}
