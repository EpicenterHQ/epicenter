/**
 * The shell's side of a desktop app's connections, as the page sees it: a
 * connection's fetch and its key, over a stand-in shell.
 *
 * Key behaviors:
 * - A connection's fetch names the connection and sends no key; the shell's
 *   refusals and failures arrive as `ConnectionFetchError`
 * - A connection's key goes to the shell, which keeps it; the page never reads it back
 */
import { describe, expect, test } from 'bun:test';
import type { TauriShell } from '@epicenter/account/tauri';
import { connectionFetch, connectionKey } from './tauri.js';

type Sent = { command: string; args?: Record<string, unknown> };
type Listener = (message: unknown) => void;

/** A shell that answers each command with `answer`, recording what was sent. */
function shell(
	answer: (command: string, args?: Record<string, unknown>) => unknown,
) {
	const sent: Sent[] = [];
	const fake: TauriShell = {
		async invoke<T>(command: string, args?: Record<string, unknown>) {
			sent.push({ command, args });
			const value = answer(command, args);
			if (value instanceof Error) throw value;
			return value as T;
		},
		channel: (onMessage: Listener) => ({ onMessage }),
	};
	return { fake, sent };
}

/** Send `messages` on the channel a relay's fetch was given, in order. */
function replying(...messages: unknown[]) {
	return (command: string, args?: Record<string, unknown>) => {
		if (command !== 'connection_fetch') return null;
		const channel = args?.onEvent as { onMessage: Listener };
		const { onMessage } = channel;
		queueMicrotask(() => {
			for (const message of messages) onMessage(message);
		});
		return null;
	};
}

describe('a connection’s fetch', () => {
	const ENDPOINT = 'http://127.0.0.1:1234/v1';

	test('names the connection and streams the endpoint’s answer back', async () => {
		const encoder = new TextEncoder();
		const { fake, sent } = shell(
			replying(
				{
					kind: 'head',
					status: 200,
					headers: [['content-type', 'text/event-stream']],
				},
				encoder.encode('data: one\n\n').buffer,
				encoder.encode('data: two\n\n').buffer,
				{ kind: 'end' },
			),
		);
		const response = await connectionFetch('conn-1', fake)(
			`${ENDPOINT}/chat/completions`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"stream":true}',
			},
		);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(await response.text()).toBe('data: one\n\ndata: two\n\n');
		const request = sent[0]?.args?.request as Record<string, unknown>;
		expect(sent[0]?.command).toBe('connection_fetch');
		expect(request.connection).toBe('conn-1');
		expect(request.url).toBe(`${ENDPOINT}/chat/completions`);
		expect(atob(request.body as string)).toBe('{"stream":true}');
	});

	test('a request the shell refuses rejects with its named error', async () => {
		const refusing: TauriShell = {
			invoke: async () => {
				throw { name: 'OriginRefused', message: 'Saved for elsewhere.' };
			},
			channel: (onMessage: Listener) => ({ onMessage }),
		};
		const error = await connectionFetch(
			'conn-1',
			refusing,
		)('https://evil.example/v1/models').catch((cause) => cause);
		expect(error.name).toBe('OriginRefused');
		expect(error.message).toBe('Saved for elsewhere.');
	});

	test('an answer that breaks off errors the body with its named error', async () => {
		const { fake } = shell(
			replying(
				{ kind: 'head', status: 200, headers: [] },
				Array.from(new TextEncoder().encode('data: one')),
				{ kind: 'error', name: 'SendFailed', message: 'reset' },
			),
		);
		const response = await connectionFetch(
			'conn-1',
			fake,
		)(`${ENDPOINT}/chat/completions`);
		const error = await response.text().catch((cause) => cause);
		expect(error.name).toBe('SendFailed');
	});

	test('with no connection the shell is asked to send with no key', async () => {
		const { fake, sent } = shell(
			replying({ kind: 'head', status: 200, headers: [] }, { kind: 'end' }),
		);
		await connectionFetch(null, fake)('http://localhost:11434/v1/models');
		const request = sent[0]?.args?.request as Record<string, unknown>;
		expect(request.connection).toBeNull();
	});

	test('an abort cancels the request in the shell', async () => {
		const { fake, sent } = shell(() => null);
		const controller = new AbortController();
		const pending = connectionFetch('conn-1', fake)(`${ENDPOINT}/models`, {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toThrow();
		await Promise.resolve();
		expect(sent.map(({ command }) => command)).toEqual([
			'connection_fetch',
			'connection_fetch_cancel',
		]);
	});
});

describe('a connection’s key', () => {
	test('goes to the shell with its endpoint, moves, and is forgotten, never read back', async () => {
		const { fake, sent } = shell(() => null);
		await connectionKey.set('groq', 'https://api.groq.com/v1', 'sk-1', fake);
		await connectionKey.move(
			'groq',
			'https://api.groq.com/v1',
			'https://b/v1',
			fake,
		);
		await connectionKey.set('groq', '', null, fake);
		expect(sent).toEqual([
			{
				command: 'connection_key_set',
				args: { id: 'groq', endpoint: 'https://api.groq.com/v1', key: 'sk-1' },
			},
			{
				command: 'connection_key_move',
				args: {
					id: 'groq',
					from: 'https://api.groq.com/v1',
					to: 'https://b/v1',
				},
			},
			{
				command: 'connection_key_set',
				args: { id: 'groq', endpoint: '', key: null },
			},
		]);
	});
});
