/**
 * Local Mail MCP Server Tests
 *
 * Drives `local-mail mcp` as a real subprocess over stdio JSON-RPC. The test
 * proves an MCP host can list tools, query mirrored body text, read status, and
 * receive protocol errors separately from tool-result errors.
 *
 * Key behaviors:
 * - stdout contains only JSON-RPC frames
 * - `query` returns body_text rows from a read-only db open
 * - `status` reports cursor and row counts
 * - malformed calls use the protocol error channel
 */

import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailDb } from './db.ts';
import type { GmailMessage } from './schema.ts';
import { createFileTokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

const BIN = join(import.meta.dir, 'bin.ts');
const ACCOUNT = 'you@example.com';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-mcp-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function base64Url(input: string): string {
	return Buffer.from(input, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function seedMirror(dir: string): void {
	const message: GmailMessage = {
		id: 'm1',
		threadId: 't1',
		labelIds: ['INBOX'],
		snippet: 'Quarterly plan',
		internalDate: '1719000000000',
		payload: {
			headers: [
				{ name: 'Subject', value: 'Quarterly plan' },
				{ name: 'From', value: 'sender@example.com' },
			],
			parts: [
				{
					mimeType: 'text/plain',
					body: { data: base64Url('The launch budget is in this email body.') },
				},
			],
		},
	};
	const db = openMailDb({ dataDir: dir, accountEmail: ACCOUNT });
	db.ingestFullPullPage([message], '2026-07-01T00:00:00.000Z');
	db.ingestLabels(
		[
			{ id: 'INBOX', name: 'INBOX', type: 'system' },
			{ id: 'Label_1', name: 'Work', type: 'user' },
		],
		's1',
	);
	db.finishFullPull('1000', '2026-07-01T00:00:00.000Z');
	db.close();
}

async function seedToken(dir: string): Promise<void> {
	const token: TokenSet = {
		accountEmail: ACCOUNT,
		clientIdUsed: 'client-id',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		obtainedAt: new Date(0).toISOString(),
	};
	await createFileTokenStore(join(dir, 'credentials.json')).set(token);
}

type JsonRpcMessage = {
	jsonrpc: string;
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

function startMcp(env: Record<string, string>) {
	const proc = Bun.spawn([process.execPath, BIN, 'mcp'], {
		env: {
			...process.env,
			LOCAL_MAIL_DIR: '',
			LOCAL_MAIL_ACCOUNT: '',
			LOCAL_MAIL_TOKEN_FILE: '',
			...env,
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const pending = new Map<number, (msg: JsonRpcMessage) => void>();
	const stdoutLines: string[] = [];
	let nextId = 1;

	(async () => {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const nl = buffer.indexOf('\n');
				if (nl === -1) break;
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				stdoutLines.push(line);
				let msg: JsonRpcMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
			}
		}
	})();

	const write = (obj: unknown) => {
		proc.stdin.write(`${JSON.stringify(obj)}\n`);
		proc.stdin.flush();
	};

	const request = (
		method: string,
		params?: unknown,
	): Promise<JsonRpcMessage> => {
		const id = nextId++;
		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`timed out waiting for ${method}`)),
				4000,
			);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			write({ jsonrpc: '2.0', id, method, params });
		});
	};

	return {
		request,
		notify: (method: string, params?: unknown) =>
			write({ jsonrpc: '2.0', method, params }),
		stdoutLines,
		stop: () => {
			proc.kill();
		},
	};
}

async function connect(env: Record<string, string>) {
	const mcp = startMcp(env);
	const init = await mcp.request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'local-mail-test', version: '0.0.0' },
	});
	expect(init.result?.serverInfo).toMatchObject({ name: 'local-mail' });
	mcp.notify('notifications/initialized');
	return mcp;
}

test('mcp: tools/list, body query, status, errors, and a clean stream', async () => {
	const tmp = tempDir();
	seedMirror(tmp.dir);
	const mcp = await connect({
		LOCAL_MAIL_DIR: tmp.dir,
		LOCAL_MAIL_ACCOUNT: ACCOUNT,
	});

	try {
		const list = await mcp.request('tools/list');
		const tools = (list.result?.tools ?? []) as Array<{
			name: string;
			description?: string;
			inputSchema: { type: string; properties?: Record<string, unknown> };
			annotations?: {
				readOnlyHint?: boolean;
				destructiveHint?: boolean;
				idempotentHint?: boolean;
			};
		}>;
		const names = tools.map((tool) => tool.name).sort();
		expect(names).toEqual(['assert_labels', 'query', 'reconcile', 'status']);
		const query = tools.find((tool) => tool.name === 'query');
		expect(query?.description).toContain('messages(id, raw JSON');
		expect(query?.description).toContain('labels(id, raw JSON');
		// The one thing an agent must not get wrong: mirrored labels are Gmail's
		// last word, effective_labels is what the app shows.
		expect(query?.description).toContain('effective_labels');
		expect(query?.description).toContain('capped at 1000 rows');
		expect(query?.inputSchema.properties).toHaveProperty('sql');
		expect(query?.annotations?.readOnlyHint).toBe(true);
		const reconcile = tools.find((tool) => tool.name === 'reconcile');
		expect(reconcile?.annotations?.readOnlyHint).toBe(false);
		expect(reconcile?.annotations?.destructiveHint).toBe(false);
		const assertLabels = tools.find((tool) => tool.name === 'assert_labels');
		expect(assertLabels?.inputSchema.properties).toHaveProperty('ids');
		expect(assertLabels?.inputSchema.properties).toHaveProperty('addLabels');
		expect(assertLabels?.inputSchema.properties).toHaveProperty('removeLabels');
		expect(assertLabels?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		});

		const ok = await mcp.request('tools/call', {
			name: 'query',
			arguments: {
				sql: "SELECT subject, body_text FROM messages WHERE body_text LIKE '%launch budget%'",
			},
		});
		expect(ok.result?.isError).toBeFalsy();
		const data = ok.result?.structuredContent as {
			rows: Array<{ subject: string; body_text: string }>;
			rowCount: number;
		};
		expect(data.rowCount).toBe(1);
		expect(data.rows[0]?.body_text).toContain('launch budget');

		const status = await mcp.request('tools/call', {
			name: 'status',
			arguments: {},
		});
		const statusData = status.result?.structuredContent as {
			accountEmail: string;
			mirror: string;
			historyId: string;
			rows: { messages: number; labels: number };
		};
		expect(statusData.accountEmail).toBe(ACCOUNT);
		expect(statusData.mirror).toBe('ready');
		expect(statusData.historyId).toBe('1000');
		expect(statusData.rows).toEqual({ messages: 1, labels: 2 });

		const reconcileWithoutToken = await mcp.request('tools/call', {
			name: 'reconcile',
			arguments: {},
		});
		expect(reconcileWithoutToken.error).toBeUndefined();
		expect(reconcileWithoutToken.result?.isError).toBe(true);

		const unknown = await mcp.request('tools/call', {
			name: 'does_not_exist',
			arguments: {},
		});
		expect(unknown.error?.code).toBe(-32601);

		const badSql = await mcp.request('tools/call', {
			name: 'query',
			arguments: { sql: 'SELECT * FROM missing_table' },
		});
		expect(badSql.error).toBeUndefined();
		expect(badSql.result?.isError).toBe(true);

		const badArgs = await mcp.request('tools/call', {
			name: 'query',
			arguments: { sql: 123 },
		});
		expect(badArgs.error?.code).toBe(-32602);

		for (const line of mcp.stdoutLines) {
			const parsed = JSON.parse(line);
			expect(parsed.jsonrpc).toBe('2.0');
		}
	} finally {
		mcp.stop();
		tmp.cleanup();
	}
});

test('mcp: LOCAL_MAIL_READ_ONLY hides mutation tools but leaves reads and reconcile listed', async () => {
	const tmp = tempDir();
	seedMirror(tmp.dir);
	const mcp = await connect({
		LOCAL_MAIL_DIR: tmp.dir,
		LOCAL_MAIL_ACCOUNT: ACCOUNT,
		LOCAL_MAIL_READ_ONLY: '1',
	});

	try {
		const list = await mcp.request('tools/list');
		const tools = (list.result?.tools ?? []) as Array<{ name: string }>;
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'query',
			'reconcile',
			'status',
		]);

		const hidden = await mcp.request('tools/call', {
			name: 'assert_labels',
			arguments: {
				ids: ['m1'],
				addLabels: ['Work'],
			},
		});
		expect(hidden.error?.code).toBe(-32601);
	} finally {
		mcp.stop();
		tmp.cleanup();
	}
});

test('mcp: assert_labels records locally, and reconcile is what reaches Gmail', async () => {
	const tmp = tempDir();
	seedMirror(tmp.dir);
	await seedToken(tmp.dir);
	const requests: Array<{ method: string; pathname: string; body: unknown }> =
		[];
	const apiServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === 'POST' ? await request.json() : null;
			requests.push({ method: request.method, pathname: url.pathname, body });
			if (url.pathname === '/gmail/v1/users/me/messages/m1/modify') {
				return Response.json({
					id: 'm1',
					threadId: 't1',
					labelIds: ['Label_1'],
				});
			}
			// The pull phase: this mirror's last sync is old enough that the pass
			// chooses FULL, so answer the whole backfill with the one message.
			if (url.pathname === '/gmail/v1/users/me/profile') {
				return Response.json({ historyId: '1001', emailAddress: ACCOUNT });
			}
			if (url.pathname === '/gmail/v1/users/me/messages') {
				return Response.json({ messages: [{ id: 'm1' }] });
			}
			if (url.pathname === '/gmail/v1/users/me/messages/m1') {
				return Response.json({
					id: 'm1',
					threadId: 't1',
					labelIds: ['Label_1'],
					internalDate: '1719000000000',
					payload: { headers: [{ name: 'Subject', value: 'Quarterly plan' }] },
				});
			}
			if (url.pathname === '/gmail/v1/users/me/labels') {
				return Response.json({
					labels: [
						{ id: 'INBOX', name: 'INBOX', type: 'system' },
						{ id: 'Label_1', name: 'Work', type: 'user' },
					],
				});
			}
			return new Response('not found', { status: 404 });
		},
	});
	const mcp = await connect({
		LOCAL_MAIL_DIR: tmp.dir,
		LOCAL_MAIL_ACCOUNT: ACCOUNT,
		LOCAL_MAIL_GMAIL_API_BASE: `http://127.0.0.1:${apiServer.port}`,
	});

	try {
		const ok = await mcp.request('tools/call', {
			name: 'assert_labels',
			arguments: {
				ids: ['m1'],
				addLabels: ['Work'],
				removeLabels: ['INBOX'],
			},
		});
		expect(ok.error).toBeUndefined();
		expect(ok.result?.isError).toBeFalsy();
		expect(ok.result?.structuredContent).toEqual({
			asserted: 2,
			withdrawn: 0,
		});
		// The act reached nothing on the network. Gmail hears from the reconciler.
		expect(requests).toEqual([]);

		// ...and yet the very next read already reflects it, because the read
		// models compose facts with intent.
		const query = await mcp.request('tools/call', {
			name: 'query',
			arguments: {
				sql: `SELECT label_id FROM effective_labels WHERE message_id = 'm1' ORDER BY label_id`,
			},
		});
		const data = query.result?.structuredContent as {
			rows: Array<{ label_id: string }>;
		};
		expect(data.rows.map((row) => row.label_id)).toEqual(['Label_1']);

		const reconciled = await mcp.request('tools/call', {
			name: 'reconcile',
			arguments: {},
		});
		expect(reconciled.error).toBeUndefined();
		expect(reconciled.result?.isError).toBeFalsy();
		expect(reconciled.result?.structuredContent).toMatchObject({
			delivery: { pending: 2, delivered: 2, retained: 0, failure: null },
		});

		// One message, one modify, carrying both opinions.
		expect(requests).toContainEqual({
			method: 'POST',
			pathname: '/gmail/v1/users/me/messages/m1/modify',
			body: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
		});
		expect(requests.filter((r) => r.pathname.endsWith('/modify'))).toHaveLength(
			1,
		);

		// Nothing is owed any more, and the mirror now holds Gmail's own answer.
		const after = await mcp.request('tools/call', {
			name: 'query',
			arguments: {
				sql: `SELECT label_ids FROM messages WHERE id = 'm1'`,
			},
		});
		const afterData = after.result?.structuredContent as {
			rows: Array<{ label_ids: string }>;
		};
		expect(JSON.parse(afterData.rows[0]?.label_ids ?? '[]')).toEqual([
			'Label_1',
		]);
	} finally {
		mcp.stop();
		apiServer.stop(true);
		tmp.cleanup();
	}
});

test('mcp: an unknown label name is refused without recording anything', async () => {
	const tmp = tempDir();
	seedMirror(tmp.dir);
	await seedToken(tmp.dir);
	const mcp = await connect({
		LOCAL_MAIL_DIR: tmp.dir,
		LOCAL_MAIL_ACCOUNT: ACCOUNT,
	});

	try {
		const refused = await mcp.request('tools/call', {
			name: 'assert_labels',
			arguments: { ids: ['m1'], addLabels: ['Nope'] },
		});
		expect(refused.error).toBeUndefined();
		expect(refused.result?.isError).toBe(true);
		const content = refused.result?.content as Array<{ text: string }>;
		expect(content[0]?.text).toContain('Unknown Gmail label "Nope"');
	} finally {
		mcp.stop();
		tmp.cleanup();
	}
});

test('mcp: a failed reconcile pass returns isError instead of a successful outcome payload', async () => {
	const tmp = tempDir();
	await seedToken(tmp.dir);
	const apiServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return new Response('profile unavailable', { status: 400 });
		},
	});
	const mcp = await connect({
		LOCAL_MAIL_DIR: tmp.dir,
		LOCAL_MAIL_ACCOUNT: ACCOUNT,
		LOCAL_MAIL_GMAIL_API_BASE: `http://127.0.0.1:${apiServer.port}`,
	});

	const failed = await mcp.request('tools/call', {
		name: 'reconcile',
		arguments: {},
	});

	expect(failed.error).toBeUndefined();
	expect(failed.result?.isError).toBe(true);
	const content = failed.result?.content as Array<{ text: string }>;
	expect(content[0]?.text).toContain('Http');
	expect(content[0]?.text).toContain('Gmail API returned 400');
	expect(content[0]?.text).toContain('Nothing was lost');

	mcp.stop();
	apiServer.stop(true);
	tmp.cleanup();
});

test('mcp: exits at startup when no account is connected', async () => {
	const tmp = tempDir();
	const proc = Bun.spawn([process.execPath, BIN, 'mcp'], {
		env: {
			...process.env,
			LOCAL_MAIL_DIR: tmp.dir,
			LOCAL_MAIL_ACCOUNT: '',
			LOCAL_MAIL_TOKEN_FILE: '',
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stderr = await new Response(proc.stderr).text();
	const stdout = await new Response(proc.stdout).text();

	expect(exitCode).toBe(1);
	expect(stderr).toContain('No Gmail account connected');
	// stdout is the JSON-RPC channel; a startup failure must not touch it.
	expect(stdout).toBe('');
	tmp.cleanup();
});
