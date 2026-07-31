/**
 * Projects the approved editions named in `syndication.json` into committed
 * Markdown under `src/content/writing/`.
 *
 * This script is a local authoring tool. It never runs during `astro build`,
 * never runs in CI, and is not on any deployment path. The site builds from the
 * committed Markdown alone, so a clone with no Vault beside it produces exactly
 * the deployed site.
 *
 * ## The boundary
 *
 * Braden's Vault holds private pages, journal entries, in-flight productions,
 * review artifacts, and delivery metadata. None of that may reach a public
 * build, and "we were careful" is not a mechanism. So the reach of this script
 * is bounded by construction rather than by discipline:
 *
 * - `syndication.json` names every republishable edition by its exact UUIDv7.
 *   There is no glob, no directory walk over `pages/`, and no "publish
 *   everything approved since" mode. An edition that is not written down here
 *   cannot be projected.
 * - `readArticle` is the only function in this file that reads an article body,
 *   and it accepts only an allowlisted id. `readPublicSlugs` reads the sibling
 *   editions to resolve cross-references, and it returns two public strings per
 *   edition — the ones already visible in a bradenwong.com URL — discarding
 *   every body it parses.
 * - Every id is checked against a UUIDv7 pattern before it becomes a path, so
 *   no entry can traverse out of `editions/`.
 * - Edition frontmatter is dropped wholesale rather than filtered. Delivery
 *   receipts, permalinks, skip reasons, facet membership, and resonance are
 *   operational metadata; the projection rebuilds the frontmatter it wants from
 *   named fields instead of removing the ones it does not.
 * - No bytes are copied. Audio, video, and images stay owned by the canonical
 *   site and are referenced by their public URL, which is verified to answer
 *   before it is written down.
 *
 * ## Usage
 *
 *   bun run --cwd apps/landing project:editions
 *   bun run --cwd apps/landing project:editions -- --check
 *
 * `VAULT_ROOT` locates the Vault (default `../vault` beside the repository).
 * `--check` regenerates into memory and fails if the committed output differs,
 * which is how you find out that a reapproved edition has moved on without the
 * site. `--offline` trusts local Vault files instead of asking the public site
 * what it currently serves.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** UUIDv7, the only shape an edition folder name may take. */
const EDITION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type AllowlistEntry = {
	readonly editionId: string;
	readonly slug: string;
	readonly why: string;
};

type Allowlist = {
	readonly canonicalOrigin: string;
	readonly editions: readonly AllowlistEntry[];
};

type Frontmatter = Readonly<Record<string, unknown>>;

const HERE = new URL('.', import.meta.url).pathname;
const APP_ROOT = resolve(HERE, '..');
const OUT_DIR = join(APP_ROOT, 'src/content/writing');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const OFFLINE = args.has('--offline');

function fail(message: string): never {
	console.error(`project-editions: ${message}`);
	process.exit(1);
}

/**
 * Where the Vault lives. It sits beside the repository by convention, but a
 * worktree is several directories deeper than the repository root, so the
 * convention is expressed against `$HOME/Code` and overridden by `VAULT_ROOT`
 * whenever that is wrong.
 */
function locateVault(): string {
	const declared = process.env.VAULT_ROOT;
	const candidate = declared
		? resolve(declared)
		: join(homedir(), 'Code', 'vault');
	if (!existsSync(join(candidate, 'editions'))) {
		fail(
			`no Vault editions directory at ${candidate}. Set VAULT_ROOT to the Vault checkout.\n` +
				'This script is a local authoring tool; the site itself builds without it.',
		);
	}
	return candidate;
}

/** Splits `---\n…\n---\n` off the front of an authored Markdown file. */
function splitFrontmatter(source: string): {
	frontmatter: Frontmatter;
	body: string;
} {
	if (!source.startsWith('---\n')) {
		return { frontmatter: {}, body: source };
	}
	const end = source.indexOf('\n---', 3);
	if (end === -1) return { frontmatter: {}, body: source };
	const raw = source.slice(4, end);
	const body = source.slice(source.indexOf('\n', end + 1) + 1);
	const parsed = Bun.YAML.parse(raw);
	const frontmatter =
		parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Frontmatter)
			: {};
	return { frontmatter, body };
}

function requireString(
	frontmatter: Frontmatter,
	key: string,
	editionId: string,
): string {
	const value = frontmatter[key];
	if (typeof value !== 'string' || value.length === 0) {
		fail(`edition ${editionId} has no \`${key}\` in its frontmatter`);
	}
	return value;
}

/**
 * Reads one allowlisted edition's article. The only body-reading path in this
 * file, and it cannot be handed an id the allowlist did not name.
 */
async function readArticle(
	vaultRoot: string,
	allowed: ReadonlySet<string>,
	editionId: string,
): Promise<{ frontmatter: Frontmatter; body: string }> {
	if (!allowed.has(editionId)) {
		fail(`refused to read edition ${editionId}: not in syndication.json`);
	}
	if (!EDITION_ID.test(editionId)) {
		fail(`refused to read edition ${editionId}: not a UUIDv7 edition id`);
	}
	const path = join(vaultRoot, 'editions', editionId, 'article.md');
	if (!existsSync(path)) fail(`edition ${editionId} has no article.md`);
	return splitFrontmatter(await readFile(path, 'utf8'));
}

/**
 * The page-filename to public-slug map used to resolve cross-references between
 * articles. Both values already appear in public bradenwong.com URLs, and every
 * body parsed here is discarded: this returns strings, never prose.
 *
 * A page with several release rounds resolves through its newest edition, since
 * UUIDv7 folder names sort by approval and the newest round owns the root slug.
 */
async function readPublicSlugs(
	vaultRoot: string,
): Promise<ReadonlyMap<string, string>> {
	const editionsDir = join(vaultRoot, 'editions');
	const ids = (await readdir(editionsDir)).filter((id) => EDITION_ID.test(id));
	ids.sort();

	const slugs = new Map<string, string>();
	for (const id of ids) {
		const path = join(editionsDir, id, 'article.md');
		if (!existsSync(path)) continue;
		const { frontmatter } = splitFrontmatter(await readFile(path, 'utf8'));
		const page = frontmatter.page;
		const slug = frontmatter.slug;
		if (typeof page === 'string' && typeof slug === 'string') {
			slugs.set(page, slug);
		}
	}
	return slugs;
}

/** One HEAD per distinct URL, so a run asks the canonical site as little as it can. */
const reachable = new Map<string, Promise<boolean>>();

function answers(url: string): Promise<boolean> {
	const cached = reachable.get(url);
	if (cached) return cached;
	const probe = fetch(url, { method: 'HEAD', redirect: 'follow' })
		.then((response) => response.ok)
		.catch(() => false);
	reachable.set(url, probe);
	return probe;
}

/**
 * Whether the canonical site currently serves this address. Media that does not
 * answer is left out of the projection entirely, because a Listen or Watch
 * control wired to a 404 is worse than no control at all.
 */
async function serves(url: string, localFallback: string): Promise<boolean> {
	if (OFFLINE) return existsSync(localFallback);
	return answers(url);
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * The intrinsic size of an image, read from its header.
 *
 * An `<img>` with no `width`/`height` occupies no height until its bytes
 * arrive, so every paragraph below it jumps down when they do. Markdown's
 * `![alt](src)` cannot carry dimensions, so the projection emits real HTML with
 * them instead, and the browser reserves the right box from first paint.
 *
 * Only the formats an approved article has actually used are supported. An
 * unrecognized one fails the run rather than silently reintroducing the shift.
 */
function readImageSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...bytes.subarray(start, start + length));

	// PNG: IHDR is always the first chunk.
	if (ascii(1, 3) === 'PNG') {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}

	// GIF: logical screen descriptor, little endian.
	if (ascii(0, 3) === 'GIF') {
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	}

	// JPEG: walk the segment chain to the frame header.
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = bytes[offset + 1] ?? 0;
			// SOF0..SOF15, excluding the non-frame markers in that range.
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					height: view.getUint16(offset + 5),
					width: view.getUint16(offset + 7),
				};
			}
			offset += 2 + view.getUint16(offset + 2);
		}
		return null;
	}

	// WebP: three container flavours, all little endian.
	if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
		const chunk = ascii(12, 4);
		if (chunk === 'VP8X') {
			const u24 = (at: number) =>
				(bytes[at] ?? 0) |
				((bytes[at + 1] ?? 0) << 8) |
				((bytes[at + 2] ?? 0) << 16);
			return { width: u24(24) + 1, height: u24(27) + 1 };
		}
		if (chunk === 'VP8 ') {
			return {
				width: view.getUint16(26, true) & 0x3fff,
				height: view.getUint16(28, true) & 0x3fff,
			};
		}
		if (chunk === 'VP8L') {
			const bits =
				(bytes[21] ?? 0) |
				((bytes[22] ?? 0) << 8) |
				((bytes[23] ?? 0) << 16) |
				((bytes[24] ?? 0) << 24);
			return {
				width: (bits & 0x3fff) + 1,
				height: ((bits >> 14) & 0x3fff) + 1,
			};
		}
	}

	return null;
}

const measured = new Map<
	string,
	Promise<{ width: number; height: number } | null>
>();

function measure(
	url: string,
): Promise<{ width: number; height: number } | null> {
	const cached = measured.get(url);
	if (cached) return cached;
	const probe = fetch(url)
		.then(async (response) =>
			response.ok
				? readImageSize(new Uint8Array(await response.arrayBuffer()))
				: null,
		)
		.catch(() => null);
	measured.set(url, probe);
	return probe;
}

/**
 * Rewrites an authored body's Vault-relative references into public canonical
 * addresses.
 *
 * Local files referenced by an approved article were captured into that
 * edition's `assets/`, which the canonical site serves. A `.md` reference names
 * another Vault page: it becomes that page's public article route when the page
 * has one, and otherwise the anchor is dropped so the sentence reads as
 * ordinary prose. That is the canonical site's own rule, and it is what keeps a
 * syndicated copy from linking somewhere only Braden can go.
 */
async function rewriteReferences(
	body: string,
	editionId: string,
	editionDir: string,
	origin: string,
	slugs: ReadonlyMap<string, string>,
): Promise<{ body: string; dropped: string[] }> {
	const dropped: string[] = [];
	const pattern = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;

	// Every replacement needs a network answer and `String.replace` cannot
	// await, so resolve the matches in order first and then splice them back in.
	const replacements: string[] = [];
	for (const match of body.matchAll(pattern)) {
		const whole = match[0];
		const bang = match[1] ?? '';
		const text = match[2] ?? '';
		const target = match[3] ?? '';

		if (ABSOLUTE.test(target)) {
			replacements.push(whole);
			continue;
		}
		const relative = target.replace(/^\.\//, '');

		if (relative.endsWith('.md')) {
			const slug = slugs.get(relative.slice(0, -3));
			const url = slug ? `${origin}/${slug}/` : undefined;
			if (url && (OFFLINE || (await answers(url)))) {
				replacements.push(`[${text}](${url})`);
			} else {
				dropped.push(relative);
				replacements.push(text);
			}
			continue;
		}

		const assetUrl = `${origin}/editions/${editionId}/assets/${relative}`;
		if (!(await serves(assetUrl, join(editionDir, 'assets', relative)))) {
			fail(
				`edition ${editionId} references ${relative}, but ${assetUrl} does not answer.\n` +
					'Deploy the canonical site before projecting, or drop this edition from syndication.json.',
			);
		}

		if (bang !== '!') {
			replacements.push(`[${text}](${assetUrl})`);
			continue;
		}

		// An image becomes real HTML so it can carry its intrinsic size.
		const size = OFFLINE ? null : await measure(assetUrl);
		if (!size && !OFFLINE) {
			fail(
				`could not read the dimensions of ${assetUrl}.\n` +
					'Every projected image needs width and height, or the article reflows when it loads.',
			);
		}
		const alt = text.replace(/"/g, '&quot;');
		replacements.push(
			size
				? `<img src="${assetUrl}" alt="${alt}" width="${size.width}" height="${size.height}" loading="lazy" decoding="async">`
				: `![${text}](${assetUrl})`,
		);
	}

	let index = 0;
	const rewritten = body.replace(
		pattern,
		(whole) => replacements[index++] ?? whole,
	);
	return { body: rewritten, dropped };
}

/** The first `# ` heading is the work's title, and the page header renders it. */
function liftTitle(body: string): { title: string; body: string } {
	const match = body.match(/^#\s+(.+?)\s*$/m);
	const title = match?.[1];
	if (!match || !title) fail('article body has no top-level heading');
	const withoutTitle = body.replace(match[0], '');
	return { title, body: withoutTitle.replace(/^\s+/, '') };
}

/** Frontmatter values here are scalars and string lists, so JSON is valid YAML. */
function toYaml(fields: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
			continue;
		}
		if (value !== null && typeof value === 'object') {
			lines.push(`${key}:`);
			for (const [nested, nestedValue] of Object.entries(value)) {
				lines.push(`  ${nested}: ${JSON.stringify(nestedValue)}`);
			}
			continue;
		}
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	return lines.join('\n');
}

/** The authored day, without a timezone conversion moving it across midnight. */
function authoredDay(value: string): string {
	const match = value.match(/^\d{4}-\d{2}-\d{2}/);
	if (!match) fail(`unrecognized date \`${value}\``);
	return match[0];
}

/** `fail` never returns, which is what makes this a total accessor. */
function requireApproval(frontmatter: Frontmatter, editionId: string): string {
	const approvedOn = frontmatter.approved_on;
	if (approvedOn === undefined || approvedOn === null) {
		fail(`edition ${editionId} is not approved; it cannot be republished`);
	}
	return String(approvedOn);
}

async function main(): Promise<void> {
	const vaultRoot = locateVault();
	const allowlist = JSON.parse(
		await readFile(join(APP_ROOT, 'syndication.json'), 'utf8'),
	) as Allowlist;

	const origin = allowlist.canonicalOrigin.replace(/\/$/, '');
	const allowed = new Set(allowlist.editions.map((entry) => entry.editionId));
	if (allowed.size !== allowlist.editions.length) {
		fail('syndication.json lists the same edition twice');
	}

	const slugs = await readPublicSlugs(vaultRoot);
	const written: string[] = [];
	const drift: string[] = [];

	for (const entry of allowlist.editions) {
		const { editionId, slug } = entry;
		const { frontmatter, body } = await readArticle(
			vaultRoot,
			allowed,
			editionId,
		);

		const actualSlug = requireString(frontmatter, 'slug', editionId);
		if (actualSlug !== slug) {
			fail(
				`edition ${editionId} now publishes as \`${actualSlug}\`, but syndication.json says \`${slug}\`. ` +
					'Update the allowlist deliberately.',
			);
		}
		const approvedOn = requireApproval(frontmatter, editionId);
		const writtenOn = authoredDay(
			requireString(frontmatter, 'date', editionId),
		);

		const editionDir = join(vaultRoot, 'editions', editionId);
		const canonicalUrl = `${origin}/${slug}/`;
		if (!OFFLINE && !(await answers(canonicalUrl))) {
			fail(
				`${canonicalUrl} does not answer. epicenter.so may only republish work that is live at its canonical home.`,
			);
		}

		const narrationUrl = `${origin}/editions/${editionId}/narration.mp3`;
		const videoUrl = `${origin}/editions/${editionId}/video.mp4`;
		const coverUrl = `${origin}/editions/${editionId}/cover.png`;

		const hasNarration = await serves(
			narrationUrl,
			join(editionDir, 'narration.mp3'),
		);
		const hasVideo =
			(await serves(
				videoUrl,
				join(editionDir, 'renditions/short-video/video.mp4'),
			)) &&
			(await serves(
				coverUrl,
				join(editionDir, 'renditions/short-video/cover.png'),
			));

		const { title, body: untitled } = liftTitle(body);
		const { body: rewritten, dropped } = await rewriteReferences(
			untitled,
			editionId,
			editionDir,
			origin,
			slugs,
		);

		const tags = Array.isArray(frontmatter.tags)
			? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
			: [];

		const projected = `---\n${toYaml({
			title,
			subtitle:
				typeof frontmatter.subtitle === 'string'
					? frontmatter.subtitle
					: undefined,
			writtenOn,
			approvedOn,
			editionId,
			canonicalUrl,
			editionUrl: `${origin}/editions/${editionId}/`,
			tags,
			narrationUrl: hasNarration ? narrationUrl : undefined,
			video: hasVideo ? { src: videoUrl, poster: coverUrl } : undefined,
		})}\n---\n\n${rewritten.trimEnd()}\n`;

		const outPath = join(OUT_DIR, `${slug}.md`);
		const existing = existsSync(outPath)
			? await readFile(outPath, 'utf8')
			: null;

		if (CHECK_ONLY) {
			if (existing !== projected) drift.push(slug);
		} else if (existing !== projected) {
			await mkdir(OUT_DIR, { recursive: true });
			await writeFile(outPath, projected);
			written.push(slug);
		}

		const renditions = ['Read', hasNarration && 'Listen', hasVideo && 'Watch']
			.filter(Boolean)
			.join(' / ');
		console.log(
			`  ${slug.padEnd(48)} ${renditions}${dropped.length ? `  (dropped ${dropped.length} unpublished link${dropped.length === 1 ? '' : 's'})` : ''}`,
		);
	}

	const expected = new Set(
		allowlist.editions.map((entry) => `${entry.slug}.md`),
	);
	const orphans = existsSync(OUT_DIR)
		? (await readdir(OUT_DIR)).filter(
				(file) => file.endsWith('.md') && !expected.has(file),
			)
		: [];
	if (orphans.length > 0) {
		console.warn(
			`\n  ${orphans.length} file(s) in src/content/writing/ are no longer in syndication.json: ${orphans.join(', ')}\n  Delete them deliberately, and redirect their routes.`,
		);
	}

	if (CHECK_ONLY) {
		if (drift.length > 0) {
			fail(
				`\ncommitted projection is stale for: ${drift.join(', ')}\n` +
					'Run `bun run --cwd apps/landing project:editions` and commit the result.',
			);
		}
		console.log('\n  committed projection matches the Vault.');
		return;
	}

	console.log(
		written.length > 0
			? `\n  wrote ${written.length} file(s) to src/content/writing/.`
			: '\n  already up to date.',
	);
}

await main();
