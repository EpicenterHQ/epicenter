/**
 * Which build gets which leaf.
 *
 * The failure this guards is silent: drop the `epicenter-host` leaf from a seam
 * and resolution falls back to `default`, so a host build would run the
 * browser implementation while still building and still starting.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const imports = (
	(await Bun.file(join(packageRoot, 'package.json')).json()) as {
		imports: Record<string, Record<string, string>>;
	}
).imports;
const seams = Object.entries(imports);

describe('platform seams', () => {
	test('each platform-dependent capability selects a browser or host leaf', () => {
		expect(seams.map(([specifier]) => specifier).sort()).toEqual([
			'#platform/clipboard',
			'#platform/resources',
		]);
	});

	test('every seam names a host leaf and a default leaf, and nothing else', () => {
		for (const [specifier, conditions] of seams) {
			expect({ specifier, conditions: Object.keys(conditions).sort() }).toEqual(
				{ specifier, conditions: ['default', 'epicenter-host'] },
			);
		}
	});

	test('every declared leaf is a file that exists', () => {
		for (const [, conditions] of seams)
			for (const leaf of Object.values(conditions))
				expect({ leaf, exists: existsSync(join(packageRoot, leaf)) }).toEqual({
					leaf,
					exists: true,
				});
	});
});
