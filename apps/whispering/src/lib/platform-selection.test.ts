/**
 * Which build gets which leaf.
 *
 * Whispering's seams split on one axis: `epicenter-host` when the Bun host
 * owns the thing behind the seam, `default` when the page does, which is the
 * `bun dev:whispering` browser tab (ADR-0347). Every other `#platform/*` entry
 * is a plain path alias to one module, because ADR-0227 refused the build that
 * used to choose.
 *
 * The failure this guards is silent. Drop the `epicenter-host` leaf from a seam
 * and resolution falls back to `default`, so the host-served build would go
 * looking for a credential only a browser can obtain, while still building and
 * still starting. This reads the declarations, so it says which seam lost a
 * leaf in milliseconds.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

const imports = (
	(await Bun.file(join(appRoot, 'package.json')).json()) as {
		imports: Record<string, string | Record<string, string>>;
	}
).imports;

const seams = Object.entries(imports).filter(
	(entry): entry is [string, Record<string, string>] =>
		typeof entry[1] !== 'string',
);
const aliases = Object.entries(imports).filter(
	(entry): entry is [string, string] => typeof entry[1] === 'string',
);

describe('platform seams', () => {
	test('the host supplies authentication, storage, and native capture', () => {
		expect(seams.map(([specifier]) => specifier).sort()).toEqual([
			'#platform/app-blobs',
			'#platform/auth',
			'#platform/manual-recorder-config',
			'#platform/recording',
			'#platform/sqlite',
		]);
	});

	test('every seam names a host leaf and a default leaf, and nothing else', () => {
		for (const [specifier, conditions] of seams) {
			expect({ specifier, conditions: Object.keys(conditions).sort() }).toEqual(
				{ specifier, conditions: ['default', 'epicenter-host'] },
			);
		}
	});

	test('every declared leaf and alias is a file that exists', () => {
		const leaves = [
			...aliases.map(([, leaf]) => leaf),
			...seams.flatMap(([, conditions]) => Object.values(conditions)),
		];
		for (const leaf of leaves) {
			expect({ leaf, exists: existsSync(join(appRoot, leaf)) }).toEqual({
				leaf,
				exists: true,
			});
		}
	});
});
