/** Platform normalization: empty reads, thrown platform failures, and write passthrough. */
import { describe, expect, test } from 'bun:test';
import { type ClipboardSource, createClipboard } from './clipboard.js';

function source(overrides: Partial<ClipboardSource> = {}) {
	const written: string[] = [];
	const clipboard = createClipboard({
		readText: async () => written.at(-1) ?? '',
		async writeText(text) {
			written.push(text);
		},
		...overrides,
	});
	return { clipboard, written };
}

describe('readText', () => {
	test('returns the platform text', async () => {
		const { clipboard } = source({ readText: async () => 'hello' });
		expect(await clipboard.readText()).toEqual({ data: 'hello', error: null });
	});

	test.each([
		['', 'empty'],
		[null, 'null'],
		[undefined, 'undefined'],
	])('normalizes a %p (%s) platform read to null', async (value) => {
		const { clipboard } = source({ readText: async () => value });
		expect(await clipboard.readText()).toEqual({ data: null, error: null });
	});

	test('converts a platform failure to ClipboardRead', async () => {
		const cause = new DOMException(
			'Document is not focused.',
			'NotAllowedError',
		);
		const { clipboard } = source({
			readText: async () => {
				throw cause;
			},
		});
		const result = await clipboard.readText();
		expect(result.data).toBeNull();
		expect(result.error).toMatchObject({
			name: 'ClipboardRead',
			message: 'Failed to read from clipboard: Document is not focused.',
			cause,
		});
	});
});

describe('writeText', () => {
	test('writes through and reads back', async () => {
		const { clipboard, written } = source();
		expect(await clipboard.writeText('copied')).toEqual({
			data: undefined,
			error: null,
		});
		expect(written).toEqual(['copied']);
		expect(await clipboard.readText()).toEqual({ data: 'copied', error: null });
	});

	test('converts a platform failure to ClipboardWrite', async () => {
		const cause = new Error('denied');
		const { clipboard } = source({
			writeText: async () => {
				throw cause;
			},
		});
		expect((await clipboard.writeText('x')).error).toMatchObject({
			name: 'ClipboardWrite',
			message: 'Failed to write to clipboard: denied',
			cause,
		});
	});
});
