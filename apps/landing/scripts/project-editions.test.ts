/**
 * Which Vault editions this site publishes, and which it refuses.
 *
 * The projection itself needs a deployed canonical site to verify media
 * against, so it is not what these tests exercise. Selection is, because
 * selection is the whole editorial decision: it is what replaced a hand-written
 * allowlist, and getting it wrong either republishes a superseded round or
 * silently drops an article Braden approved.
 *
 * Each case builds a small Vault on disk rather than a stub, so the outlet
 * contract, the facet contracts, and the edition frontmatter are read exactly
 * the way the real run reads Braden's.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OUTLET, projectOutlet, readImageSize } from './project-editions';

const CANONICAL_ORIGIN = 'https://bradenwong.com';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

type EditionFixture = {
	id: string;
	page: string;
	slug: string;
	facets: readonly string[];
	approvedOn?: string;
};

type FacetFixture = {
	name: string;
	state?: 'active' | 'prospective';
	outlets?: readonly string[];
};

/** Writes a Vault with just enough of Braden's shape to resolve an outlet. */
async function writeVault(options: {
	facets: readonly FacetFixture[];
	editions: readonly EditionFixture[];
}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'landing-vault-'));
	roots.push(root);

	mkdirSync(join(root, 'outlets/blog'), { recursive: true });
	await writeFile(
		join(root, 'outlets/blog/bradenwong.com.md'),
		`---\nrenderer: web\nvisibility: public\ncanonical_web: true\ncanonical_origin: ${CANONICAL_ORIGIN}\n---\n`,
	);
	await writeFile(
		join(root, 'outlets/blog/epicenter.so.md'),
		'---\nrenderer: web\nvisibility: public\n---\n',
	);

	mkdirSync(join(root, 'facets'), { recursive: true });
	for (const facet of options.facets) {
		const outlets = (facet.outlets ?? []).map((ref) => `\n  - ${ref}`).join('');
		await writeFile(
			join(root, 'facets', `${facet.name}.md`),
			`---\nstate: ${facet.state ?? 'active'}\noutlets:${outlets || ' []'}\n---\n`,
		);
	}

	for (const edition of options.editions) {
		mkdirSync(join(root, 'editions', edition.id), { recursive: true });
		const facets = edition.facets.map((name) => `\n  - ${name}`).join('');
		const approved = edition.approvedOn
			? `approved_on: ${edition.approvedOn}\n`
			: '';
		await writeFile(
			join(root, 'editions', edition.id, 'article.md'),
			`---\npage: ${edition.page}\nslug: ${edition.slug}\ndate: 2026-07-12\nfacets:${facets}\n${approved}---\n\n# ${edition.slug}\n`,
		);
	}

	return root;
}

/** UUIDv7s written in ascending release order, so the newest is the last. */
const ROUND = {
	first: '019f960c-d15a-7000-883c-a9e9449ac1b8',
	second: '019faa69-203f-7000-a527-4439c8b98749',
	third: '019fb024-9bf5-7000-8d0f-3761ce2dd490',
} as const;

const BUILDS_EPICENTER: FacetFixture = {
	name: 'builds-epicenter',
	outlets: [OUTLET, 'x/braden'],
};

describe('projectOutlet', () => {
	test('publishes only editions whose facets carry this outlet', async () => {
		const root = await writeVault({
			facets: [BUILDS_EPICENTER, { name: 'curates', outlets: ['x/braden'] }],
			editions: [
				{
					id: ROUND.first,
					page: 'hi-im-braden',
					slug: 'hello-world',
					facets: ['builds-epicenter', 'curates'],
					approvedOn: '2026-07-24',
				},
				{
					id: ROUND.second,
					page: 'read-out-loud',
					slug: 'read-your-writing-out-loud',
					facets: ['curates'],
					approvedOn: '2026-07-25',
				},
			],
		});

		const { canonicalOrigin, memberFacets, selections } =
			await projectOutlet(root);

		expect(canonicalOrigin).toBe(CANONICAL_ORIGIN);
		expect(memberFacets).toEqual(['builds-epicenter']);
		expect(selections).toEqual([
			{
				editionId: ROUND.first,
				page: 'hi-im-braden',
				slug: 'hello-world',
				originFacet: 'builds-epicenter',
			},
		]);
	});

	test("names the first facet in the edition's order that carries the outlet", async () => {
		const root = await writeVault({
			facets: [
				BUILDS_EPICENTER,
				{ name: 'codes', outlets: [OUTLET] },
				{ name: 'curates', outlets: [] },
			],
			editions: [
				{
					id: ROUND.first,
					page: 'hi-im-braden',
					slug: 'hello-world',
					facets: ['curates', 'codes', 'builds-epicenter'],
					approvedOn: '2026-07-24',
				},
			],
		});

		const { selections } = await projectOutlet(root);
		expect(selections[0]?.originFacet).toBe('codes');
	});

	test('a release-again round replaces the round before it', async () => {
		const root = await writeVault({
			facets: [BUILDS_EPICENTER],
			editions: [
				{
					id: ROUND.first,
					page: 'enemies-to-lovers',
					slug: 'enemies-to-lovers',
					facets: ['builds-epicenter'],
					approvedOn: '2026-07-29',
				},
				{
					id: ROUND.third,
					page: 'enemies-to-lovers',
					slug: 'enemies-to-lovers',
					facets: ['builds-epicenter'],
					approvedOn: '2026-07-30',
				},
			],
		});

		const { selections } = await projectOutlet(root);
		expect(selections).toHaveLength(1);
		expect(selections[0]?.editionId).toBe(ROUND.third);
	});

	test('a release-again round that drops the facet withdraws the article', async () => {
		const root = await writeVault({
			facets: [BUILDS_EPICENTER],
			editions: [
				{
					id: ROUND.first,
					page: 'enemies-to-lovers',
					slug: 'enemies-to-lovers',
					facets: ['builds-epicenter'],
					approvedOn: '2026-07-29',
				},
				{
					id: ROUND.third,
					page: 'enemies-to-lovers',
					slug: 'enemies-to-lovers',
					facets: ['curates'],
					approvedOn: '2026-07-30',
				},
			],
		});

		const { selections } = await projectOutlet(root);
		expect(selections).toEqual([]);
	});

	test('an unapproved round in flight leaves the published round alone', async () => {
		const root = await writeVault({
			facets: [BUILDS_EPICENTER],
			editions: [
				{
					id: ROUND.first,
					page: 'hi-im-braden',
					slug: 'hello-world',
					facets: ['builds-epicenter'],
					approvedOn: '2026-07-24',
				},
				{
					id: ROUND.third,
					page: 'hi-im-braden',
					slug: 'hello-world-revised',
					facets: ['builds-epicenter'],
				},
			],
		});

		const { selections } = await projectOutlet(root);
		expect(selections).toEqual([
			{
				editionId: ROUND.first,
				page: 'hi-im-braden',
				slug: 'hello-world',
				originFacet: 'builds-epicenter',
			},
		]);
	});

	test('a prospective facet is a promise nobody has made, so it publishes nothing', async () => {
		const root = await writeVault({
			facets: [{ name: 'reflects', state: 'prospective', outlets: [OUTLET] }],
			editions: [
				{
					id: ROUND.first,
					page: 'hi-im-braden',
					slug: 'hello-world',
					facets: ['reflects'],
					approvedOn: '2026-07-24',
				},
			],
		});

		const { memberFacets, selections } = await projectOutlet(root);
		expect(memberFacets).toEqual([]);
		expect(selections).toEqual([]);
	});
});

/**
 * Every projected image carries the intrinsic size read from its own header, so
 * the article reserves the right box before the bytes arrive. Both the online
 * and the offline run measure through this one function, over the same bytes,
 * which is what keeps their output identical.
 *
 * Each case is the smallest header the format can express, built here rather
 * than committed as a fixture file, so what the parser reads is visible beside
 * what it is expected to return.
 */
describe('readImageSize', () => {
	const bytes = (...parts: readonly (number | string)[]): Uint8Array =>
		Uint8Array.from(
			parts.flatMap((part) =>
				typeof part === 'string'
					? [...part].map((character) => character.charCodeAt(0))
					: [part],
			),
		);

	const be16 = (value: number) => [value >> 8, value & 0xff];
	const be32 = (value: number) => [0, 0, ...be16(value)];
	const le16 = (value: number) => [value & 0xff, value >> 8];
	const le24 = (value: number) => [...le16(value & 0xffff), value >> 16];

	test('PNG reads IHDR, the first chunk', () => {
		const png = bytes(
			0x89,
			'PNG',
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...be32(13),
			'IHDR',
			...be32(1425),
			...be32(2218),
		);
		expect(readImageSize(png)).toEqual({ width: 1425, height: 2218 });
	});

	test('GIF reads the logical screen descriptor', () => {
		const gif = bytes('GIF89a', ...le16(640), ...le16(480));
		expect(readImageSize(gif)).toEqual({ width: 640, height: 480 });
	});

	test('JPEG walks the segment chain to the frame header', () => {
		// A comment segment first, so the walk has something to step over.
		const jpeg = bytes(
			0xff,
			0xd8,
			0xff,
			0xfe,
			...be16(4),
			0x00,
			0x00,
			0xff,
			0xc0,
			...be16(11),
			0x08,
			...be16(300),
			...be16(200),
			// Start of scan, because a real frame header is never the last segment.
			0xff,
			0xda,
		);
		expect(readImageSize(jpeg)).toEqual({ width: 200, height: 300 });
	});

	test('WebP reads VP8X, which is the flavour approved articles use', () => {
		const webp = bytes(
			'RIFF',
			...le16(0),
			...le16(0),
			'WEBP',
			'VP8X',
			...be32(10),
			0x00,
			0x00,
			0x00,
			0x00,
			...le24(1425 - 1),
			...le24(2218 - 1),
		);
		expect(readImageSize(webp)).toEqual({ width: 1425, height: 2218 });
	});

	test('an unrecognized header returns null, so the run can refuse it', () => {
		expect(readImageSize(bytes('not an image at all'))).toBeNull();
	});
});
