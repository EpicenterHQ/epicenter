/**
 * The `local-books mcp` stdio server, driven as a real subprocess over JSON-RPC.
 * This proves the protocol contract end-to-end without a model: a foreign host
 * speaks framed JSON-RPC on stdin/stdout, lists tools, and calls them.
 *
 * The assertions guard the four things that make this an airlock and not a leak:
 *  - the two error channels are distinct (unknown tool -> JSON-RPC protocol
 *    error; a tool that ran and failed -> an `isError` result the model reads);
 *  - the read-only gate removes `recategorize` from the catalog entirely;
 *  - `query` returns mirror rows;
 *  - stdout carries ONLY JSON-RPC frames (a single stray byte corrupts framing).
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { booksDbFile, openBooksDb } from '../src/db.ts';
import { tempRoot } from './helpers.ts';

const BIN = join(import.meta.dir, '../src/bin.ts');
const REALM = 'r1';

/** Seed the r1 company's current mirror artifact with two live invoices. */
function seedMirror(dir: string): void {
	const db = openBooksDb(booksDbFile(dir, REALM));
	db.raw.exec(`
		CREATE TABLE invoices (
			id TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_at TEXT,
			synced_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
			doc_number TEXT, total_amt REAL
		);
		INSERT INTO invoices (id, raw, synced_at, deleted, doc_number, total_amt) VALUES
			('1', '{"Id":"1"}', '2026-01-01', 0, 'INV-1', 8000.0),
			('2', '{"Id":"2"}', '2026-01-01', 0, 'INV-2', 4500.0);
	`);
	db.close();
}

type JsonRpcMessage = {
	jsonrpc: string;
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

/** A live MCP subprocess speaking newline-delimited JSON-RPC over stdio. */
function startMcp(env: Record<string, string>) {
	const proc = Bun.spawn([process.execPath, BIN, 'mcp'], {
		// Neutralize any ambient data root and LOCAL_BOOKS_* from the dev shell so
		// the read-only gate assertions are deterministic; each test passes what it
		// needs.
		env: {
			...process.env,
			EPICENTER_DATA_DIR: '',
			LOCAL_BOOKS_READ_ONLY: '',
			LOCAL_BOOKS_TOKEN_FILE: '',
			...env,
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const pending = new Map<number, (msg: JsonRpcMessage) => void>();
	/** Every non-empty stdout line, so the clean-stream check sees any leak. */
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
					continue; // recorded above; the clean-stream check will catch it
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

/** Run the initialize handshake, then return the open connection. */
async function connect(env: Record<string, string>) {
	const mcp = startMcp(env);
	const init = await mcp.request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'local-books-test', version: '0.0.0' },
	});
	expect(init.result?.serverInfo).toMatchObject({ name: 'local-books' });
	mcp.notify('notifications/initialized');
	return mcp;
}

test('mcp: tools/list, query rows, the two error channels, and a clean stream', async () => {
	const tmp = tempRoot();
	seedMirror(tmp.appDir);
	const mcp = await connect({
		EPICENTER_DATA_DIR: tmp.root,
		LOCAL_BOOKS_QB_REALM: REALM,
	});

	// tools/list: all five verbs, the gated write present, the standard safety
	// hints carried, and the TypeBox input passed straight through as a
	// JSON-Schema object.
	const list = await mcp.request('tools/list');
	const tools = (list.result?.tools ?? []) as Array<{
		name: string;
		inputSchema: { type: string; properties?: Record<string, unknown> };
		annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	}>;
	const names = tools.map((t) => t.name).sort();
	expect(names).toEqual(['query', 'recategorize', 'report', 'status', 'sync']);
	const query = tools.find((t) => t.name === 'query');
	expect(query?.inputSchema.type).toBe('object');
	expect(query?.inputSchema.properties).toHaveProperty('sql');
	// Standard host-facing safety hints: reads are read-only, the QB write is
	// destructive.
	expect(query?.annotations?.readOnlyHint).toBe(true);
	const recategorize = tools.find((t) => t.name === 'recategorize');
	expect(recategorize?.annotations?.readOnlyHint).toBe(false);
	expect(recategorize?.annotations?.destructiveHint).toBe(true);

	// query: a tool that ran and succeeded returns rows as structured content.
	const ok = await mcp.request('tools/call', {
		name: 'query',
		arguments: {
			sql: 'SELECT doc_number, total_amt FROM invoices WHERE deleted = 0 ORDER BY total_amt DESC',
		},
	});
	expect(ok.result?.isError).toBeFalsy();
	const data = ok.result?.structuredContent as {
		rows: Array<{ doc_number: string; total_amt: number }>;
		rowCount: number;
	};
	expect(data.rowCount).toBe(2);
	expect(data.rows[0]).toEqual({ doc_number: 'INV-1', total_amt: 8000 });

	// Unknown tool: a malformed call is a JSON-RPC protocol error, NOT an isError
	// result. MethodNotFound = -32601.
	const unknown = await mcp.request('tools/call', {
		name: 'does_not_exist',
		arguments: {},
	});
	expect(unknown.error?.code).toBe(-32601);
	expect(unknown.result).toBeUndefined();

	// Bad SQL: the tool ran and failed, so a self-correctable isError result, NOT
	// a protocol error.
	const badSql = await mcp.request('tools/call', {
		name: 'query',
		arguments: { sql: 'SELECT * FROM table_that_is_not_here' },
	});
	expect(badSql.error).toBeUndefined();
	expect(badSql.result?.isError).toBe(true);
	expect(
		(badSql.result?.content as Array<{ text: string }> | undefined)?.[0]?.text,
	).toContain('query failed');

	// Invalid arguments: schema validation rejects with a protocol error.
	const badArgs = await mcp.request('tools/call', {
		name: 'query',
		arguments: { sql: 123 },
	});
	expect(badArgs.error?.code).toBe(-32602);

	// The whole conversation on stdout was nothing but JSON-RPC frames.
	for (const line of mcp.stdoutLines) {
		const parsed = JSON.parse(line); // throws if a banner/log leaked
		expect(parsed.jsonrpc).toBe('2.0');
	}

	mcp.stop();
	tmp.cleanup();
});

test('mcp: read-only mode drops the recategorize write from the catalog', async () => {
	const tmp = tempRoot();
	seedMirror(tmp.appDir);
	const mcp = await connect({
		EPICENTER_DATA_DIR: tmp.root,
		LOCAL_BOOKS_QB_REALM: REALM,
		LOCAL_BOOKS_READ_ONLY: '1',
	});

	const list = await mcp.request('tools/list');
	const names = ((list.result?.tools ?? []) as Array<{ name: string }>).map(
		(t) => t.name,
	);
	expect(names).not.toContain('recategorize');
	expect(names.sort()).toEqual(['query', 'report', 'status', 'sync']);

	mcp.stop();
	tmp.cleanup();
});
