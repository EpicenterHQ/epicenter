/**
 * Home Host Tests
 *
 * Verifies that the host composes built-in app actions, optional Local Books
 * MCP tools, and one durable local replica set into a single conversation
 * surface.
 *
 * Key behaviors:
 * - Built-in app actions are namespaced and callable through the catalog.
 * - Local Books MCP failures stay on the external-tool path.
 * - Host-local app replicas survive process restart through Bun persistence.
 * - Direct invocations ride the same approval gate as chat turns and settle
 *   as session records without ever entering the transcript.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	AgentEngine,
	AgentMessagePart,
	Approval,
	EngineChunk,
} from '@epicenter/agent';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';
import { type HomeHostInputs, parseHomeCommand } from './host.ts';
import { createOwnedTestHomeHost } from './test-home-host.ts';
import { homeLens } from './workspace.ts';

const FIXTURE = new URL('../test-fixtures/mini-mcp-server.ts', import.meta.url)
	.pathname;

/**
 * A scripted engine: each model call consumes the next chunk list. The last
 * script repeats, so a trailing text answer also serves any extra step.
 */
function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

/** Auto-approve everything: the smoke tests exercise gated mutations headless. */
const APPROVE_ALL: Approval = {
	decide: () => 'auto',
	request: async () => true,
};

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'query-host-test-'));
}

const TEST_MODEL = 'test-model';

function createTestHost(
	options: Pick<
		HomeHostInputs,
		'approval' | 'engine' | 'localBooks' | 'localSource'
	>,
) {
	return createOwnedTestHomeHost({
		dataDir: testDataDir(),
		model: TEST_MODEL,
		...options,
	});
}

async function settle(host: {
	snapshot(): { conversation: { isGenerating: boolean } };
}) {
	for (let i = 0; i < 500 && host.snapshot().conversation.isGenerating; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function waitFor(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function toolResults(parts: AgentMessagePart[]) {
	return parts.filter((part) => part.type === 'tool-result');
}

/** Read the conversation rows a disposed host left behind in its data dir. */
async function readConversationRows(dataDir: string) {
	await using epicenter = await openBunEpicenter({
		directory: join(dataDir, 'data'),
		owner: null,
	});
	const conversations = epicenter.bind(homeLens).conversations;
	return (await conversations.scan()).rows;
}

describe('createHomeHost', () => {
	test('composes the in-process apps under namespaced verbs', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const names = host.toolDefinitions().map((d) => d.name);
		expect(names).toContain('honeycrisp__folders_create');
		expect(names).toContain('honeycrisp__folders_list');
		expect(names).toContain('honeycrisp__folders_delete');
	});

	test('one chat turn drives an in-process verb end to end', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'honeycrisp__folders_create',
					input: { name: 'Buy milk' },
				},
			],
			[{ type: 'text-delta', delta: 'Created your folder.' }],
		]);
		await using host = await createTestHost({
			engine,
			approval: APPROVE_ALL,
		});

		await host.handleCommand({
			type: 'send',
			content: 'create a Honeycrisp folder',
		});
		await settle(host);

		const { messages, error } = host.snapshot().conversation;
		expect(error).toBeNull();
		const results = messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		// todos_create returns the created folder row: proof the verb ran in-process.
		expect(typeof results[0]!.content).toBe('string');
		expect(messages.at(-1)!.parts).toContainEqual({
			type: 'text',
			text: 'Created your folder.',
		});
	});

	test('host-owned approval prompt gates a mutation and approval resumes the turn', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'honeycrisp__folders_create',
					input: { name: 'Needs approval' },
				},
			],
			[{ type: 'text-delta', delta: 'Created after approval.' }],
		]);
		await using host = await createTestHost({ engine });

		expect(
			await host.handleCommand({ type: 'send', content: 'create a folder' }),
		).toBe(true);
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);

		const [approval] = host.snapshot().pendingApprovals;
		expect(approval).toEqual(
			expect.objectContaining({
				toolCallId: 'call-1',
				toolName: 'honeycrisp__folders_create',
				input: { name: 'Needs approval' },
			}),
		);

		expect(
			await host.handleCommand({
				type: 'approve',
				requestId: approval!.id,
				approved: true,
			}),
		).toBe(true);
		await settle(host);

		const { messages, error } = host.snapshot().conversation;
		expect(error).toBeNull();
		expect(host.snapshot().pendingApprovals).toEqual([]);
		const results = messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(messages.at(-1)!.parts).toContainEqual({
			type: 'text',
			text: 'Created after approval.',
		});
	});

	test('always allow approves the next matching mutation without a second prompt', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'honeycrisp__folders_create',
					input: { name: 'First' },
				},
			],
			[{ type: 'text-delta', delta: 'Created first.' }],
			[
				{
					type: 'tool-call',
					toolCallId: 'call-2',
					toolName: 'honeycrisp__folders_create',
					input: { name: 'Second' },
				},
			],
			[{ type: 'text-delta', delta: 'Created second.' }],
		]);
		await using host = await createTestHost({ engine });

		await host.handleCommand({ type: 'send', content: 'add first' });
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'the first approval',
		);
		const [approval] = host.snapshot().pendingApprovals;
		await host.handleCommand({
			type: 'approve',
			requestId: approval!.id,
			approved: true,
			alwaysAllowSession: true,
		});
		await settle(host);

		await host.handleCommand({ type: 'send', content: 'add second' });
		await settle(host);

		expect(host.snapshot().pendingApprovals).toEqual([]);
		const results = host
			.snapshot()
			.conversation.messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(2);
		expect(results.every((result) => result.isError === false)).toBe(true);
	});

	test('a subprocess that never speaks MCP fails host creation fast', async () => {
		// Without the catalog's own connect timeout this would ride the SDK's
		// minute-long per-request default and the host would look wedged.
		await expect(
			createTestHost({
				engine: scriptedEngine([[]]),
				localBooks: {
					command: 'bun',
					args: ['-e', 'await new Promise(() => {})'],
					connectTimeoutMs: 300,
				},
			}),
		).rejects.toThrow(/timeout \(300ms\)/);
	});

	test('a stdio MCP subprocess joins the same composed surface', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'localbooks__customers',
					input: {},
				},
			],
			[{ type: 'text-delta', delta: 'Acme owes the most.' }],
		]);
		await using host = await createTestHost({
			engine,
			localBooks: { command: 'bun', args: [FIXTURE] },
		});

		// The read-only hint projects to a `query`, so no approval is needed.
		const customers = host
			.toolDefinitions()
			.find((d) => d.name === 'localbooks__customers');
		expect(customers?.kind).toBe('query');

		await host.handleCommand({ type: 'send', content: 'who owes me money?' });
		await settle(host);

		const { messages, error } = host.snapshot().conversation;
		expect(error).toBeNull();
		const results = messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.content).toContain('Acme | 4200.00');
	});

	test('a second host over the same data dir resumes the persisted transcript', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([
					[{ type: 'text-delta', delta: 'Hello from host A.' }],
				]),
			});
			await host.handleCommand({
				type: 'send',
				content: 'remember this session',
			});
			await settle(host);
		}

		await using host = await createOwnedTestHomeHost({
			dataDir,
			model: TEST_MODEL,
			engine: scriptedEngine([[]]),
		});
		const { messages } = host.snapshot().conversation;
		expect(messages).toHaveLength(2);
		expect(messages[0]!.parts).toContainEqual({
			type: 'text',
			text: 'remember this session',
		});
		expect(messages[1]!.parts).toContainEqual({
			type: 'text',
			text: 'Hello from host A.',
		});
	});

	test('boot creates one blank conversation; the first send names it', async () => {
		const dataDir = testDataDir();
		// Boot and dispose without ever sending.
		await (
			await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([[]]),
			})
		)[Symbol.asyncDispose]();
		const blankRows = await readConversationRows(dataDir);
		expect(blankRows).toHaveLength(1);
		expect(blankRows[0]!.title).toBe('New Chat');

		const content =
			'summarize the quarterly numbers and flag anything that looks off';
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([[{ type: 'text-delta', delta: 'Done.' }]]),
			});
			await host.handleCommand({ type: 'send', content });
			await settle(host);
		}

		const rows = await readConversationRows(dataDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.title).toBe(content.slice(0, 50));
		expect(rows[0]!.model).toBe(TEST_MODEL);
		expect(rows[0]!.updatedAt >= rows[0]!.createdAt).toBe(true);
	});

	test('a later send keeps the first-message title and bumps updatedAt', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([[{ type: 'text-delta', delta: 'Sure.' }]]),
			});
			await host.handleCommand({
				type: 'send',
				content: 'first message names it',
			});
			await settle(host);
			// Instants have millisecond resolution; a beat apart so the bump shows.
			await new Promise((resolve) => setTimeout(resolve, 5));
			await host.handleCommand({ type: 'send', content: 'second message' });
			await settle(host);
		}

		const rows = await readConversationRows(dataDir);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.title).toBe('first message names it');
		expect(rows[0]!.updatedAt > rows[0]!.createdAt).toBe(true);
	});

	test('clear starts a fresh conversation and boot resumes the most recent one', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([[{ type: 'text-delta', delta: 'Okay.' }]]),
			});
			await host.handleCommand({ type: 'send', content: 'the first session' });
			await settle(host);
			expect(await host.handleCommand({ type: 'clear' })).toBe(true);
			expect(host.snapshot().conversation.messages).toHaveLength(0);
			await new Promise((resolve) => setTimeout(resolve, 5));
			await host.handleCommand({ type: 'send', content: 'the second session' });
			await settle(host);
		}
		expect(await readConversationRows(dataDir)).toHaveLength(2);

		await using host = await createOwnedTestHomeHost({
			dataDir,
			model: TEST_MODEL,
			engine: scriptedEngine([[]]),
		});
		const { messages } = host.snapshot().conversation;
		const texts = messages.flatMap((m) =>
			m.parts.filter((part) => part.type === 'text').map((part) => part.text),
		);
		expect(texts).toContain('the second session');
		expect(texts).not.toContain('the first session');
	});

	test('a send queued behind clear lands in the new durable row', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([[{ type: 'text-delta', delta: 'New row.' }]]),
			});
			const clearing = host.handleCommand({ type: 'clear' });
			const sending = host.handleCommand({
				type: 'send',
				content: 'queued after clear',
			});
			expect(await clearing).toBe(true);
			expect(await sending).toBe(true);
			await settle(host);
			expect(host.snapshot().conversation.messages[0]?.parts).toContainEqual({
				type: 'text',
				text: 'queued after clear',
			});
		}
		expect(await readConversationRows(dataDir)).toHaveLength(1);
	});

	test('a failed clear keeps the previous durable conversation usable', async () => {
		const dataDir = testDataDir();
		await using host = await createOwnedTestHomeHost({
			dataDir,
			model: TEST_MODEL,
			engine: scriptedEngine([
				[{ type: 'text-delta', delta: 'First.' }],
				[{ type: 'text-delta', delta: 'Second.' }],
			]),
			wrapConversations(workspace) {
				let creates = 0;
				return {
					...workspace,
					conversations: {
						...workspace.conversations,
						async create(input) {
							if (creates++ > 0) {
								throw new Error('injected create failure');
							}
							return workspace.conversations.create(input);
						},
					},
				};
			},
		});
		await host.handleCommand({ type: 'send', content: 'first message' });
		await settle(host);
		await expect(host.handleCommand({ type: 'clear' })).rejects.toThrow(
			'injected create failure',
		);
		expect(
			await host.handleCommand({ type: 'send', content: 'second message' }),
		).toBe(true);
		await settle(host);
		const texts = host
			.snapshot()
			.conversation.messages.flatMap((message) =>
				message.parts
					.filter((part) => part.type === 'text')
					.map((part) => part.text),
			);
		expect(texts).toContain('first message');
		expect(texts).toContain('second message');
	});

	test('a pending approval dies with the process instead of persisting', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				model: TEST_MODEL,
				engine: scriptedEngine([
					[
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'honeycrisp__folders_create',
							input: { name: 'Never approved' },
						},
					],
				]),
			});
			await host.handleCommand({ type: 'send', content: 'create a folder' });
			await waitFor(
				() => host.snapshot().pendingApprovals.length === 1,
				'a pending approval',
			);
		}

		await using host = await createOwnedTestHomeHost({
			dataDir,
			model: TEST_MODEL,
			engine: scriptedEngine([[]]),
		});
		expect(host.snapshot().pendingApprovals).toEqual([]);
		// Only the user turn persisted; the aborted turn's partial output did not.
		const { messages } = host.snapshot().conversation;
		expect(messages).toHaveLength(1);
		expect(messages.flatMap((m) => toolResults(m.parts))).toHaveLength(0);
	});

	test('invoking a query settles succeeded without an approval or a transcript entry', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		expect(
			await host.handleCommand({
				type: 'invoke',
				toolName: 'honeycrisp__folders_list',
				input: {},
			}),
		).toBe(true);
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'succeeded',
			'the invocation to settle',
		);

		const [invocation] = host.snapshot().invocations;
		expect(invocation).toEqual(
			expect.objectContaining({
				toolName: 'honeycrisp__folders_list',
				status: 'succeeded',
			}),
		);
		expect(typeof invocation!.content).toBe('string');
		expect(invocation!.settledAt).toBeDefined();
		// A query runs unattended, and a direct run never becomes chat history.
		expect(host.snapshot().pendingApprovals).toEqual([]);
		expect(host.snapshot().conversation.messages).toEqual([]);
	});

	test('invoking an unknown tool settles failed through the shared gate', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'nope__missing',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the invocation to settle failed',
		);
		expect(host.snapshot().invocations[0]!.content).toMatch(
			/No tool named nope__missing/,
		);
	});

	test('invoking a mutation raises the same pending approval prompt as chat', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Direct with consent' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);

		const [invocation] = host.snapshot().invocations;
		expect(invocation!.status).toBe('running');
		// The prompt correlates back to the invocation: the host mints one id
		// covering the record and the gated call.
		expect(host.snapshot().pendingApprovals[0]).toEqual(
			expect.objectContaining({
				toolCallId: invocation!.id,
				toolName: 'honeycrisp__folders_create',
				input: { name: 'Direct with consent' },
			}),
		);
	});

	test('denying a direct mutation settles the invocation failed', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Denied' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host.handleCommand({
			type: 'approve',
			requestId: host.snapshot().pendingApprovals[0]!.id,
			approved: false,
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the denied invocation to settle',
		);
		expect(host.snapshot().invocations[0]!.content).toMatch(/Denied/);
		expect(host.snapshot().pendingApprovals).toEqual([]);
	});

	test('approving a direct mutation runs the tool and settles succeeded', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Approved directly' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host.handleCommand({
			type: 'approve',
			requestId: host.snapshot().pendingApprovals[0]!.id,
			approved: true,
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'succeeded',
			'the approved invocation to settle',
		);

		expect(typeof host.snapshot().invocations[0]!.content).toBe('string');
		// The created folder reads back through the product invocation path: the
		// approved mutation really ran, not just settled.
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_list',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations[1]?.status === 'succeeded',
			'the verification list invocation to settle',
		);
		expect(host.snapshot().invocations[1]!.content).toContain(
			'Approved directly',
		);
		// Direct invocation results stay session records; the transcript is untouched.
		expect(host.snapshot().conversation.messages).toEqual([]);
	});

	test('dispose settles an in-flight gated invocation failed instead of leaving it running', async () => {
		const host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Never answered' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host[Symbol.asyncDispose]();

		// Disposal aborts the invoke signal before cancelAll denies the prompt,
		// so the record settles failed rather than running the tool late.
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the invocation to settle after dispose',
		);
		expect(host.snapshot().invocations[0]!.settledAt).toBeDefined();
	});

	test('the invocation cap evicts settled records only; a running record survives', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		// One gated mutation stays running (its approval is never answered)...
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Still pending' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'the gated invocation to go pending',
		);
		const running = host.snapshot().invocations[0]!;

		// ...while more than INVOCATION_LIMIT queries settle around it. The cap
		// trims on push only, so a burst may briefly exceed it; the final push
		// converges the ring back to the limit.
		for (let i = 0; i < 25; i++) {
			await host.handleCommand({
				type: 'invoke',
				toolName: 'honeycrisp__folders_list',
				input: {},
			});
		}
		await waitFor(
			() =>
				host
					.snapshot()
					.invocations.filter((record) => record.status === 'running')
					.length === 1,
			'the query burst to settle',
		);
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_list',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations.length === 20,
			'the ring to converge to the cap',
		);

		const survivors = host.snapshot().invocations;
		expect(survivors.find((record) => record.id === running.id)).toEqual(
			expect.objectContaining({ status: 'running' }),
		);
	});

	test('a second host over the same data dir reads the first host folders through the catalog', async () => {
		const dataDir = testDataDir();
		{
			await using host = await createOwnedTestHomeHost({
				dataDir,
				engine: scriptedEngine([[]]),
				model: TEST_MODEL,
				approval: APPROVE_ALL,
			});
			await host.handleCommand({
				type: 'invoke',
				toolName: 'honeycrisp__folders_create',
				input: { name: 'Survives restart' },
			});
			await waitFor(
				() => host.snapshot().invocations[0]?.status === 'succeeded',
				'the create invocation to settle',
			);
		}

		await using host = await createOwnedTestHomeHost({
			dataDir,
			engine: scriptedEngine([[]]),
			model: TEST_MODEL,
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'honeycrisp__folders_list',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'succeeded',
			'the list invocation to settle',
		);
		expect(host.snapshot().invocations[0]!.content).toContain(
			'Survives restart',
		);
	});
});

describe('parseHomeCommand', () => {
	test('accepts an invoke frame with a tool name and an object input', () => {
		expect(
			parseHomeCommand({
				type: 'invoke',
				toolName: 'honeycrisp__folders_create',
				input: { name: 'Buy milk' },
			}),
		).toEqual({
			type: 'invoke',
			toolName: 'honeycrisp__folders_create',
			input: { name: 'Buy milk' },
		});
	});

	test('rejects invoke frames with a missing, empty, or non-string tool name', () => {
		expect(parseHomeCommand({ type: 'invoke', input: {} })).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName: '', input: {} }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName: 42, input: {} }),
		).toBeUndefined();
	});

	test('rejects invoke frames whose input is not a plain object', () => {
		const toolName = 'honeycrisp__folders_list';
		expect(parseHomeCommand({ type: 'invoke', toolName })).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: null }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: 'title' }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: [1, 2] }),
		).toBeUndefined();
	});
});
