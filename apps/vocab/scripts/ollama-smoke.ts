/**
 * Smoke test of Vocab's tutor loop against a local Ollama, with no auth, no
 * API, and no UI: the real `createConversation` over a `custom` endpoint
 * pointed at Ollama, with Vocab's messages in a temporary folder. It prints
 * the messages each step sends and the transcript it saves, so a multi-turn
 * bug can be seen without the page.
 *
 *   ollama serve                       # in another terminal
 *   ollama pull qwen3                  # or qwen3:8b, glm4, ...
 *   bun run apps/vocab/scripts/ollama-smoke.ts qwen3 "How do I say 'thank you'?" "And 'please'?"
 *
 * It also drives any hosted OpenAI-compatible endpoint (z.ai for GLM,
 * Moonshot for Kimi K2, OpenRouter, ...) by pointing OLLAMA_BASE_URL at it
 * and setting OLLAMA_API_KEY:
 *
 *   OLLAMA_BASE_URL=https://api.z.ai/api/paas/v4 \
 *   OLLAMA_API_KEY=$ZAI_KEY \
 *   bun run apps/vocab/scripts/ollama-smoke.ts glm-4.6 "How do I say 'thank you'?"
 *
 * Env:
 *   OLLAMA_BASE_URL   OpenAI-compatible base URL (default http://localhost:11434/v1)
 *   OLLAMA_API_KEY    Bearer key for a hosted endpoint (omit for local Ollama)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, custom, openAi } from '@epicenter/ai';
import { agentMessageText, createConversation } from '@epicenter/ai/agent';
import { createFolder } from '@epicenter/folder/core';
import { openDevice } from '@epicenter/folder/node';
import { Ok, unwrap } from 'wellcrafted/result';
import { tutorOpening } from '../src/lib/chat/opening.js';
import { vocab } from '../src/lib/contract.js';
import { VOCAB_SYSTEM_PROMPT } from '../src/lib/data.js';

const [model = 'qwen3', ...prompts] = process.argv.slice(2);
if (prompts.length === 0)
	prompts.push('Teach me how to order coffee in Mandarin. Keep it short.');
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
const apiKey = process.env.OLLAMA_API_KEY;

let step = 0;
const endpoint = custom({
	id: 'smoke',
	baseUrl,
	key: apiKey,
	// Print what each step sends, then send it.
	async fetch(url, init) {
		if (url.endsWith('/chat/completions')) {
			const body = JSON.parse(String(init?.body)) as {
				messages: { role: string; content: unknown }[];
			};
			console.log(`\n--- step ${++step}: messages sent ---`);
			for (const message of body.messages)
				console.log(`  [${message.role}] ${JSON.stringify(message.content)}`);
		}
		return fetch(url, init);
	},
});

/** Fail fast with a readable message when the server is down or lacks the model. */
async function preflight(): Promise<void> {
	const { data: available, error } = await createClient(endpoint).listModels();
	if (error?.name === 'Unreachable')
		throw new Error(
			`Cannot reach an OpenAI-compatible server at ${baseUrl}. Is \`ollama serve\` running? (${error.message})`,
		);
	if (error !== null) {
		console.warn(
			`! GET ${baseUrl}/models failed (${error.message}); skipping the model-present check.\n`,
		);
		return;
	}
	if (!available.some((id) => id === model || id.startsWith(`${model}:`)))
		console.warn(
			`! Model "${model}" is not in the server's list (${available.join(', ') || 'none'}). If this is Ollama, run: ollama pull ${model}\n`,
		);
}

/** Resolve once the conversation neither generates nor saves. */
function settled(conversation: ReturnType<typeof createConversation>) {
	const active = () =>
		conversation.snapshot().isGenerating || conversation.snapshot().isSaving;
	return new Promise<void>((resolve) => {
		if (!active()) return resolve();
		const stop = conversation.subscribe(() => {
			if (active()) return;
			stop();
			resolve();
		});
	});
}

async function main(): Promise<void> {
	await preflight();
	const root = await mkdtemp(join(tmpdir(), 'vocab-smoke-'));
	try {
		const client = unwrap(await openDevice(vocab, { path: root }));
		// The conversation reads the folder's messages as a page does.
		const folder = createFolder(vocab, async () => Ok(client));
		const conversation = createConversation({
			messages: folder.messages,
			chat: 'smoke',
			ai: openAi([endpoint]),
			model: () => ({ endpoint: endpoint.id, model }),
			system: VOCAB_SYSTEM_PROMPT,
			prepare: tutorOpening,
		});
		console.log(`> model:   ${model}`);
		console.log(`> backend: ${baseUrl}`);
		for (const prompt of prompts) {
			console.log(`\n========== learner: ${JSON.stringify(prompt)} ==========`);
			const { error } = await conversation.send(prompt);
			if (error !== null) throw new Error(error.message, { cause: error });
			await settled(conversation);
			const failure = conversation.snapshot().error;
			if (failure)
				throw new Error(
					`${failure.code ? `[${failure.code}] ` : ''}${failure.message}`,
				);
		}
		console.log('\n========== saved transcript ==========');
		for (const message of conversation.snapshot().messages)
			console.log(
				`[${message.role}] ${JSON.stringify(agentMessageText(message))}`,
			);
		conversation[Symbol.dispose]();
		folder[Symbol.dispose]();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
