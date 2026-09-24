/**
 * Which build gets which leaf.
 *
 * `epicenter-host` selects the desktop host and native capabilities; `default`
 * selects the browser page's capabilities. Browser leaves must not initialize
 * native IPC when the application opens.
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
import { createSystemShortcuts } from './platform/system-shortcuts.browser.js';
import { tauri } from './tauri.browser.js';

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
	test('each platform-dependent capability selects a browser or host leaf', () => {
		expect(seams.map(([specifier]) => specifier).sort()).toEqual([
			'#platform/analytics',
			'#platform/auth',
			'#platform/capture-window',
			'#platform/dictation-indicator',
			'#platform/download',
			'#platform/manual-recorder-config',
			'#platform/os',
			'#platform/os-notify',
			'#platform/recording-mic-level',
			'#platform/system-shortcuts',
			'#platform/tauri',
			'#platform/text',
			'#platform/window-events',
		]);
	});

	test('browser capabilities do not expose native commands or shortcuts', () => {
		expect(tauri).toBeNull();
		expect(createSystemShortcuts).toBeNull();
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
