/**
 * Every stock component is shadcn-svelte vega's text plus at most one patch
 * that says why (`upstream.ts`). An edit to a stock component fails here
 * until it is reverted, or recorded with `bun scripts/upstream.ts diff <name>`
 * and given its reason.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	ourFiles,
	patchedUpstream,
	readPatch,
	reasonOf,
	stockNames,
} from './upstream.ts';

/**
 * Stock components not yet rebased onto upstream's text: they still carry the
 * reformatting and the differences from before this check. Each leaves this
 * list when it is rewritten as upstream plus a patch; the list goes when it is
 * empty.
 */
const NOT_YET_REBASED = new Set([
	'command',
	'context-menu',
	'dialog',
	'popover',
	'select',
	'sidebar',
	'tabs',
]);

const stock = stockNames();
const patchesDir = join(import.meta.dir, '../upstream/patches');
const patches = existsSync(patchesDir)
	? readdirSync(patchesDir)
			.filter((file) => file.endsWith('.diff'))
			.map((file) => file.slice(0, -'.diff'.length))
	: [];

test('every patch belongs to a stock component and says why', () => {
	for (const name of patches) {
		expect([name, stock.includes(name)]).toEqual([name, true]);
		const reason = reasonOf(readPatch(name) ?? '');
		expect([name, reason.startsWith('Epicenter: ')]).toEqual([name, true]);
		expect([name, reason.includes('<why')]).toEqual([name, false]);
	}
});

test('the list of components not yet rebased names only stock components without a patch', () => {
	for (const name of NOT_YET_REBASED) {
		expect([name, stock.includes(name)]).toEqual([name, true]);
		expect([name, patches.includes(name)]).toEqual([name, false]);
	}
});

describe('each rebased stock component is upstream plus its patch', () => {
	for (const name of stock.filter((each) => !NOT_YET_REBASED.has(each))) {
		test(name, () => {
			const expected = patchedUpstream(name);
			if ('error' in expected)
				throw new Error(
					`${name}'s patch no longer applies to upstream: ${expected.error}`,
				);
			const ours = ourFiles(name);
			expect([...ours.keys()].sort()).toEqual(
				[...expected.files.keys()].sort(),
			);
			for (const [path, content] of expected.files)
				if (ours.get(path) !== content)
					throw new Error(
						`src/${path} differs from upstream and its patch. Revert it, or record the change: bun scripts/upstream.ts diff ${name}`,
					);
		});
	}
});
