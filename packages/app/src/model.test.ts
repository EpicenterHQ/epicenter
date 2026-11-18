import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { inRun } from './context.ts';
import { createMemoryContext } from './memory.ts';
import { model } from './model.ts';

const env = {
	OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1/',
	OLLAMA_API_KEY: 'ollama',
	EPICENTER_BASE_URL: 'https://api.epicenter.so/v1',
	EPICENTER_API_KEY: 'ep_test',
	MODEL: 'epicenter/openai/gpt-5.5',
};
const run = <T>(work: () => T, values: Record<string, string> = env) =>
	inRun(createMemoryContext({}, values), work);

test('with no name, the home MODEL picks the connection and the id after the first slash', async () => {
	expect(expectOk(run(() => model()))).toEqual({
		baseURL: 'https://api.epicenter.so/v1',
		id: 'openai/gpt-5.5',
		apiKey: 'ep_test',
	});
});

test('a named model overrides MODEL, and a trailing slash leaves the base URL', async () => {
	expect(expectOk(run(() => model('ollama/hf.co/org/name')))).toEqual({
		baseURL: 'http://127.0.0.1:11434/v1',
		id: 'hf.co/org/name',
		apiKey: 'ollama',
	});
});

test('a missing line is named with the file to add it to', async () => {
	const { OLLAMA_API_KEY: _, ...noKey } = env;
	expect(expectErr(run(() => model('ollama/qwen3'), noKey)).message).toBe(
		'Add OLLAMA_API_KEY=<key> to .env',
	);
	expect(expectErr(run(() => model('groq/llama'))).message).toBe(
		'Add GROQ_BASE_URL=<address> to .env',
	);
	expect(expectErr(run(() => model(), {})).message).toBe(
		'Add MODEL=<connection>/<model> to .env',
	);
});

test('a connection name outside lowercase letters and digits is refused', async () => {
	for (const name of [
		'Ollama/qwen3',
		'my-lab/qwen3',
		'2nd/qwen3',
		'ollama',
		'ollama/',
	])
		expect(expectErr(run(() => model(name))).message).toContain(
			'is not a model name',
		);
});

test('outside a run, model() throws as folder does', () => {
	expect(() => model()).toThrow("read only inside an action's run");
});
