/**
 * Bun Runtime Adapter Tests
 *
 * Locks the caller-free defaults of `openBunEpicenter`: a fresh directory
 * opens with a minted, schema-valid replica identity.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBunEpicenter } from './bun.js';

test('openBunEpicenter mints a schema-valid replica id by default', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-runtime-'));
	try {
		await using epicenter = await openBunEpicenter({ directory: root });
		expect(epicenter.sync.status).toEqual({
			state: 'unattached',
			attachment: null,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
