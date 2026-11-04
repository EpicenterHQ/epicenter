/**
 * `modelChoices()` Tests
 *
 * Under the `test` condition `@epicenter/local` keeps files in memory, so
 * these read and write `models.md` through the same `localFile` the
 * desktop's AppData and the browser's storage answer.
 *
 * Key behaviors:
 * - A choice is `models.md`, one entry per job, and the next page reads it back
 * - Another window's write reaches the choices
 * - A `models.md` that does not read is left as it is, and only defaults answer
 */
import { expect, test } from 'bun:test';
import { localFile } from '@epicenter/local';
import { modelChoices } from './model-choices.js';

const models = localFile('models.md');

async function text() {
	const read = await models.read();
	return read.data?.text ?? null;
}

test('a choice is models.md, one entry per job, and the next page reads it back', async () => {
	const choices = modelChoices<'chat' | 'transcribe'>({
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await choices.ready;
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'default' });
	await choices.set('transcribe', { endpoint: 'local-speech', model: 'base' });
	await choices.set('chat', { endpoint: 'ollama', model: 'llama3' });
	expect(await text()).toContain('job: transcribe');
	expect(await text()).toContain('model: llama3');

	const next = modelChoices<'chat' | 'transcribe'>();
	await next.ready;
	expect(next.get('chat')).toEqual({ endpoint: 'ollama', model: 'llama3' });
	expect(next.get('transcribe')).toEqual({
		endpoint: 'local-speech',
		model: 'base',
	});
	choices[Symbol.dispose]();
	next[Symbol.dispose]();
});

test('another window’s write reaches the choices', async () => {
	const choices = modelChoices<'chat'>();
	await choices.ready;
	const read = await models.read();
	await models.write(
		'---\nchoices:\n  - job: chat\n    endpoint: lm-studio\n    model: qwen\n---\n',
		read.data?.version ?? 'absent',
	);
	await Bun.sleep(0);
	expect(choices.get('chat')).toEqual({ endpoint: 'lm-studio', model: 'qwen' });
	choices[Symbol.dispose]();
});

test('a models.md that does not read is left as it is, and only defaults answer', async () => {
	const read = await models.read();
	const raw = '---\nchoices: not a list\n---\n';
	await models.write(raw, read.data?.version ?? 'absent');
	const choices = modelChoices({ chat: { endpoint: 'hosted', model: 'd' } });
	await choices.ready;
	expect(choices.problem()).toContain('models.md could not be read');
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'd' });
	expect(await text()).toBe(raw);
	choices[Symbol.dispose]();
});
