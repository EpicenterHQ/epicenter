/**
 * Messages for its end-to-end suite: built into a scratch directory and
 * served by its own local program (`scripts/serve.ts`) on
 * `http://127.0.0.1:5189`, with a fake Beeper in place of the CLI's
 * connection, so no run ever reads the keychain or reaches a real Beeper
 * Desktop. The fake answers like one installation with one test account.
 *
 *   bun apps/messages/e2e/serve.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
	BeeperAnswer,
	BeeperRequest,
	Message,
} from '@epicenter/cli/messages-protocol';
import { serveMessages } from '../scripts/serve.ts';

export const E2E_PORT = 5189;

const appDir = resolve(import.meta.dir, '..');
const out = await mkdtemp(join(tmpdir(), 'messages-e2e-'));
const built = Bun.spawnSync(
	[process.execPath, 'x', 'vite', 'build', '--logLevel', 'warn'],
	{
		cwd: appDir,
		env: { ...process.env, MESSAGES_BUILD_DIR: out },
		stdout: 'inherit',
		stderr: 'inherit',
	},
);
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);

const chat = {
	id: 'live-ada',
	title: 'Ada Test',
	network: 'Matrix',
	preview: 'Are you there?',
	activity: '2026-10-31T08:00:00Z',
};
const history: Message[] = [
	{
		id: 'live-ada-1',
		text: 'Are you there?',
		sender: 'Ada Test',
		mine: false,
		timestamp: chat.activity,
		attachment: false,
	},
];
let saved = false;

async function answer(input: unknown): Promise<BeeperAnswer> {
	// SAFETY: only the page under test asks, with the operations it sends.
	const request = input as BeeperRequest;
	switch (request.action) {
		case 'connect':
			if (!request.token && !saved)
				return { kind: 'error', message: 'Create an access token first.' };
			saved = true;
			return { kind: 'connected', profile: 'fake-test-installation' };
		case 'disconnect':
			saved = false;
			return { kind: 'disconnected' };
		case 'chats':
			return { kind: 'chats', page: { items: [chat], cursor: null } };
		case 'messages':
			return {
				kind: 'messages',
				page: { items: structuredClone(history), cursor: null },
			};
		case 'focus':
			return { kind: 'focused' };
		case 'send': {
			const message: Message = {
				id: `live-ada-${history.length + 1}`,
				text: request.text,
				sender: 'You',
				mine: true,
				timestamp: new Date().toISOString(),
				attachment: false,
				status: 'SUCCESS',
			};
			history.push(message);
			chat.preview = request.text;
			chat.activity = message.timestamp;
			return { kind: 'accepted', pendingId: message.id };
		}
	}
}

const server = serveMessages({ root: out, port: E2E_PORT, answer });
console.log(`Messages under test: ${server.url}`);
const stop = async () => {
	await server.stop(true);
	await rm(out, { recursive: true, force: true });
	process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
