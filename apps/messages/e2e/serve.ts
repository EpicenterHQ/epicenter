/**
 * Messages for its end-to-end suite: built into a scratch directory and
 * served by its own local program (`scripts/serve.ts`) on
 * `http://127.0.0.1:5189`, answering with the real send owner
 * (`openMessages`) over a scratch Messages folder (`E2E_FOLDER`) and
 * journal, with a fake Beeper in place of the CLI's connection, so no run
 * ever reads the keychain or reaches a real Beeper Desktop. The fake
 * answers like one installation with one test account; a send whose text
 * contains `[no answer]` gets no answer, as a lost connection would.
 *
 *   bun apps/messages/e2e/serve.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openMessages } from '@epicenter/cli/messages';
import type { Beeper } from '@epicenter/cli/messages-outbox';
import type { Message } from '@epicenter/cli/messages-protocol';
import { serveMessages } from '../scripts/serve.ts';

const browser = process.env.MESSAGES_E2E_BROWSER;
if (browser !== 'chromium' && browser !== 'webkit')
	throw new Error('Set MESSAGES_E2E_BROWSER to chromium or webkit.');
export const E2E_PORT = browser === 'chromium' ? 5189 : 5191;
/** The Messages folder the suite reads, made empty at each start. */
export const E2E_FOLDER = join(tmpdir(), `epicenter-messages-e2e-${browser}`, 'Messages');
const PROFILE = 'fake-test-installation';

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

const beeper: Beeper = {
	async request(request) {
		switch (request.action) {
			case 'connect':
				if (!request.token && !saved)
					return { kind: 'error', message: 'Create an access token first.' };
				saved = true;
				return { kind: 'connected', profile: PROFILE };
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
		}
	},
	async profile() {
		return saved ? { profile: PROFILE } : { message: 'Beeper is not connected.' };
	},
	async send(chatId, text) {
		if (text.includes('[no answer]'))
			return { kind: 'unknown', message: 'Beeper did not confirm the send.' };
		const message: Message = {
			id: `live-ada-${history.length + 1}`,
			text,
			sender: 'You',
			mine: true,
			timestamp: new Date().toISOString(),
			attachment: false,
			status: 'SUCCESS',
		};
		history.push(message);
		chat.preview = text;
		chat.activity = message.timestamp;
		return { kind: 'accepted', pendingId: message.id, chatId };
	},
	async status(_chatId, pendingId) {
		return {
			kind: 'status',
			status: history.some((message) => message.id === pendingId)
				? 'SUCCESS'
				: null,
		};
	},
};

const scratch = resolve(E2E_FOLDER, '..');
await rm(scratch, { recursive: true, force: true });
const messages = await openMessages({
	folder: E2E_FOLDER,
	journal: join(scratch, 'data', 'sends.sqlite'),
	beeper,
});
const server = serveMessages({
	root: out,
	port: E2E_PORT,
	answer: messages.answer,
});
console.log(`Messages under test: ${server.url}`);
const stop = async () => {
	await server.stop(true);
	messages.close();
	await rm(out, { recursive: true, force: true });
	await rm(scratch, { recursive: true, force: true });
	process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
