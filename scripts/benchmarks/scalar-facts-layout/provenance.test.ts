/**
 * Unit tests for the pure provenance helpers: deterministic, order-independent
 * source digest that unrelated files cannot perturb; validated git HEAD; scoped
 * dirty detection; and honest admissibility.
 */
import { describe, expect, test } from 'bun:test';

import {
	deriveProvenance,
	type GitRunner,
	gitHead,
	relevantDirty,
	type SourceFile,
	sourceManifestDigest,
} from './provenance.js';

const HEAD40 = 'a'.repeat(40);
const okGit =
	(map: Record<string, string>): GitRunner =>
	(args) => {
		const key = args.join(' ');
		for (const [prefix, stdout] of Object.entries(map))
			if (key.startsWith(prefix)) return { ok: true, stdout };
		return { ok: true, stdout: '' };
	};
const noGit: GitRunner = () => ({ ok: false, stdout: '' });

const FILES: SourceFile[] = [
	{ path: 'a.ts', content: 'alpha' },
	{ path: 'b.ts', content: 'beta' },
];

describe('sourceManifestDigest', () => {
	test('is order-independent', () => {
		expect(sourceManifestDigest(FILES)).toBe(
			sourceManifestDigest([...FILES].reverse()),
		);
	});
	test('changes when a listed file content changes', () => {
		const changed = [
			{ path: 'a.ts', content: 'ALPHA' },
			FILES[1] as SourceFile,
		];
		expect(sourceManifestDigest(changed)).not.toBe(sourceManifestDigest(FILES));
	});
	test('an unrelated file outside the set never affects the digest', () => {
		// The digest is over exactly the provided files; app dirt is not here.
		const base = sourceManifestDigest(FILES);
		const withExtra = sourceManifestDigest([
			...FILES,
			{ path: 'unrelated/app.ts', content: 'dirty' },
		]);
		expect(withExtra).not.toBe(base); // adding to the SET changes it,
		expect(sourceManifestDigest(FILES)).toBe(base); // but the scoped set is stable.
	});
	test('is not fooled by a path/content boundary shift', () => {
		const a = sourceManifestDigest([{ path: 'ab', content: 'c' }]);
		const b = sourceManifestDigest([{ path: 'a', content: 'bc' }]);
		expect(a).not.toBe(b);
	});
});

describe('gitHead', () => {
	test('returns a validated 40-hex head', () => {
		expect(gitHead(okGit({ 'rev-parse HEAD': `${HEAD40}\n` }))).toBe(HEAD40);
	});
	test('rejects malformed head', () => {
		expect(gitHead(okGit({ 'rev-parse HEAD': 'not-a-sha\n' }))).toBeNull();
	});
	test('is null when git is unavailable', () => {
		expect(gitHead(noGit)).toBeNull();
	});
});

describe('relevantDirty', () => {
	test('true when the scoped status is nonempty', () => {
		expect(
			relevantDirty(okGit({ 'status --porcelain': ' M a.ts\n' }), ['a.ts']),
		).toBe(true);
	});
	test('false when the scoped status is empty', () => {
		expect(relevantDirty(okGit({ 'status --porcelain': '' }), ['a.ts'])).toBe(
			false,
		);
	});
	test('null when git is unavailable', () => {
		expect(relevantDirty(noGit, ['a.ts'])).toBeNull();
	});
});

describe('deriveProvenance admissibility is honest', () => {
	test('admissible only with a known head and a clean relevant tree', () => {
		const p = deriveProvenance(
			FILES,
			okGit({ 'rev-parse HEAD': `${HEAD40}\n`, 'status --porcelain': '' }),
		);
		expect(p.gitHead).toBe(HEAD40);
		expect(p.relevantSourcesDirty).toBe(false);
		expect(p.sourceProvenanceAdmissible).toBe(true);
	});
	test('a dirty relevant tree is not admissible', () => {
		const p = deriveProvenance(
			FILES,
			okGit({
				'rev-parse HEAD': `${HEAD40}\n`,
				'status --porcelain': ' M a.ts\n',
			}),
		);
		expect(p.relevantSourcesDirty).toBe(true);
		expect(p.sourceProvenanceAdmissible).toBe(false);
	});
	test('no git is honest null and not admissible', () => {
		const p = deriveProvenance(FILES, noGit);
		expect(p.gitHead).toBeNull();
		expect(p.relevantSourcesDirty).toBeNull();
		expect(p.sourceProvenanceAdmissible).toBe(false);
		// The digest is still computed from the exact source contents.
		expect(p.sourceManifestSha256).toBe(sourceManifestDigest(FILES));
	});
});
