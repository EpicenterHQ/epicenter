/** The Bun reference admits one active server owner per persistent root. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataRootOwner } from './data-root-owner.js';

test('a second owner is refused until the first releases the root', () => {
	const root = mkdtempSync(join(tmpdir(), 'self-host-owner-'));
	try {
		const release = acquireDataRootOwner(root);
		expect(() => acquireDataRootOwner(root)).toThrow(
			'Another Bun server owns data root',
		);
		release();
		const second = acquireDataRootOwner(root);
		second();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
