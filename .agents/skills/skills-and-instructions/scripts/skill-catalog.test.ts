/**
 * Skill catalog tests.
 *
 * The frontmatter reader has to survive the shapes descriptions are actually
 * written in here: quoted scalars with embedded quotes, block scalars wrapped
 * across lines, and sibling fields like `metadata` that must not bleed in.
 *
 * `classifyClaim` is the part worth defending. Substring matching reports a
 * near-miss clause as a claim, which turns the routing audit into noise, so
 * these tests pin the claim / disclaim / absent split.
 */

import { describe, expect, test } from 'bun:test';
import { classifyClaim, extractFrontmatterField } from './skill-catalog';

describe('extractFrontmatterField', () => {
	test('reads a single-line field', () => {
		const md =
			'---\nname: svelte\ndescription: Svelte 5 patterns.\n---\n# Body\n';
		expect(extractFrontmatterField(md, 'description')).toBe(
			'Svelte 5 patterns.',
		);
	});

	test('joins a wrapped description onto one line', () => {
		const md = '---\nname: x\ndescription: First part\n  second part\n---\n';
		expect(extractFrontmatterField(md, 'description')).toBe(
			'First part second part',
		);
	});

	test('strips surrounding quotes without eating inner ones', () => {
		const md = '---\ndescription: "Use for \\"in one sentence\\"."\n---\n';
		expect(extractFrontmatterField(md, 'description')).toBe(
			'Use for \\"in one sentence\\".',
		);
	});

	test('stops at the next top-level field', () => {
		const md = '---\ndescription: Only this.\nmetadata:\n  version: 2\n---\n';
		expect(extractFrontmatterField(md, 'description')).toBe('Only this.');
	});

	test('returns empty when there is no frontmatter', () => {
		expect(extractFrontmatterField('# Just a heading\n', 'description')).toBe(
			'',
		);
	});

	test('returns empty when the field is missing', () => {
		expect(extractFrontmatterField('---\nname: x\n---\n', 'description')).toBe(
			'',
		);
	});
});

describe('classifyClaim', () => {
	const controlFlow =
		'Control flow: early returns, guard clauses, linearizing nested logic. ' +
		'Use for "flatten these conditions", "too many nested ifs". ' +
		'For a broad "simplify this" pass over a diff or package, use collapse-pass instead.';

	test('claims a phrase carried by a trigger sentence', () => {
		expect(classifyClaim(controlFlow, 'nested ifs')).toBe('claims');
	});

	test('disclaims a phrase carried only by a near-miss sentence', () => {
		expect(classifyClaim(controlFlow, 'simplify this')).toBe('disclaims');
	});

	test('reports absent when the description never mentions the phrase', () => {
		expect(classifyClaim(controlFlow, 'asymmetric win')).toBe('absent');
	});

	test('matches case-insensitively and as a substring', () => {
		expect(
			classifyClaim(
				'Use when the user asks to Hand Off the implementation.',
				'hand off',
			),
		).toBe('claims');
	});

	test('claims when one sentence routes the phrase away but another owns it', () => {
		const mixed =
			'Use for "fresh eyes" on a diff. Not for fresh eyes on a product decision.';
		expect(classifyClaim(mixed, 'fresh eyes')).toBe('claims');
	});

	test('does not split on a dot inside a token', () => {
		expect(
			classifyClaim('Finds console.* in library code.', 'console.* in library'),
		).toBe('claims');
	});

	test('treats an empty phrase as absent', () => {
		expect(classifyClaim(controlFlow, '  ')).toBe('absent');
	});
});
