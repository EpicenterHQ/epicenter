import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	acquireBunAuthorityOwnerV1,
	openBunAuthorityControlV1,
} from './bun-authority-control-v1.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

test('Bun authority control activates with a durable compare-and-swap', () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-authority-control-'));
	let control = openBunAuthorityControlV1(dir);
	try {
		expect(control.active()).toBeUndefined();
		control.initialize(FIRST);
		expect(control.active()).toBe(FIRST);
		expect(() => control.initialize(FIRST)).toThrow('already initialized');
		expect(control.activate(OTHER, SECOND).kind).toBe('unchanged');
		expect(control.active()).toBe(FIRST);
		expect(control.activate(FIRST, SECOND)).toEqual({ kind: 'activated' });
		expect(control.active()).toBe(SECOND);
		control.close();
		control = openBunAuthorityControlV1(dir);
		expect(control.active()).toBe(SECOND);
	} finally {
		control.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun authority owner excludes a second live process owner', () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-authority-owner-'));
	const owner = acquireBunAuthorityOwnerV1(dir);
	try {
		expect(() => acquireBunAuthorityOwnerV1(dir)).toThrow('already owned');
		owner.close();
		const reopened = acquireBunAuthorityOwnerV1(dir);
		reopened.close();
	} finally {
		owner.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Bun authority control rejects a lookalike schema', () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-authority-control-'));
	try {
		const raw = new Database(join(dir, 'control-v1.sqlite'), {
			create: true,
			strict: true,
		});
		raw.run(
			`CREATE TABLE active_authority (
				singleton INTEGER PRIMARY KEY,
				authority_lifetime TEXT NOT NULL
			) STRICT`,
		);
		raw.close();
		expect(() => openBunAuthorityControlV1(dir)).toThrow(
			'control schema is not recognized',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
