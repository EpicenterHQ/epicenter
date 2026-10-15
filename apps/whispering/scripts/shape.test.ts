/**
 * The committed `shape.json` is what Epicenter matches folders against
 * (ADR-0538), so it must declare Whispering's definition. The text may be
 * formatted; the declaration may not differ.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { formatDeclaration } from '@epicenter/folder';
import { whisperingDefinition } from '../src/lib/definition.ts';

test('shape.json declares the Whispering definition (bun run shape)', async () => {
	const committed = await Bun.file(
		join(import.meta.dir, '..', 'shape.json'),
	).json();
	expect(committed).toEqual(
		JSON.parse(formatDeclaration(whisperingDefinition)),
	);
});
