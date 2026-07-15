/**
 * Headless reproduction of the vocab chat over the REAL agent loop
 * (`createConversation`), with an in-memory store, against local Ollama. It logs
 * the exact prompt the engine receives on each step and the messages the loop
 * persists, so a multi-turn rendering bug can be seen without the browser UI.
 *
 *   bun run apps/vocab/scripts/loop-repro.ts qwen3:30b-a3b-instruct-2507-q4_K_M
 */

import {
	type AgentEngine,
	createOpenAiAgentEngine,
	resolveConnection,
} from '@epicenter/client';
import {
	type AgentMessage,
	type AgentMessageStore,
	agentMessageText,
	createConversation,
} from '@epicenter/workspace/agent';
import { VOCAB_SYSTEM_PROMPT } from '../vocab.js';

const model = process.argv[2] ?? 'qwen3:30b-a3b-instruct-2507-q4_K_M';
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';

/** Minimal in-memory store implementing exactly the agent loop's seam. */
function inMemoryStore(): AgentMessageStore {
	const map = new Map<string, AgentMessage>();
	const handlers = new Set<() => void>();
	return {
		set: (k, v) => {
			map.set(k, v);
			for (const h of handlers) h();
		},
		*entries() {
			for (const [key, val] of map) yield { key, val };
		},
		observe(h) {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		[Symbol.dispose]() {},
	};
}

/** Wrap the engine to print the prompt it receives each step. */
function loggingEngine(inner: AgentEngine): AgentEngine {
	let step = 0;
	return (request, signal) => {
		step += 1;
		console.log(`\n--- engine call #${step}: prompt messages ---`);
		for (const m of request.messages) {
			console.log(`  [${m.role}] ${JSON.stringify(m.content)}`);
		}
		console.log('--- (streaming reply) ---');
		return inner(request, signal);
	};
}

/**
 * Send a turn and resolve when it finishes. `send` synchronously starts the turn
 * (isGenerating true) before returning, so we subscribe AFTER send and wait for
 * it to go false again. Subscribing before send would race on send's user-message
 * write and resolve immediately.
 */
function sendAndWait(
	convo: ReturnType<typeof createConversation>,
	text: string,
): Promise<void> {
	convo.send(text);
	if (!convo.snapshot().isGenerating) return Promise.resolve();
	return new Promise((resolve) => {
		const unsub = convo.subscribe(() => {
			if (!convo.snapshot().isGenerating) {
				unsub();
				resolve();
			}
		});
	});
}

async function main(): Promise<void> {
	const { fetch, baseURL } = resolveConnection({ baseUrl });
	const engine = loggingEngine(
		createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL,
				model,
				systemPrompts: [VOCAB_SYSTEM_PROMPT],
			}),
		}),
	);

	let nextId = 0;
	const convo = createConversation({
		store: inMemoryStore(),
		engine,
		generateId: () => `m${nextId++}`,
	});

	for (const userText of ['Hello!', 'Test', "What's your name?"]) {
		console.log(
			`\n========== USER SENDS: ${JSON.stringify(userText)} ==========`,
		);
		await sendAndWait(convo, userText);
	}

	console.log('\n========== PERSISTED TRANSCRIPT ==========');
	for (const m of convo.snapshot().messages) {
		console.log(`[${m.role}] ${JSON.stringify(agentMessageText(m))}`);
	}
	const err = convo.snapshot().error;
	if (err) console.log('ERROR:', err);
	convo[Symbol.dispose]();
}

main().catch((e: unknown) => {
	console.error('✗', e instanceof Error ? e.message : String(e));
	process.exit(1);
});
