/**
 * Constrained renderer tests.
 *
 * These pin the whole public HTML contract: the lead-title ownership (Vault
 * ADR-0059: the lead H1 becomes the web title), the explicit Markdown
 * subset, the escape-everything-else refusal behavior, static canonical/OG
 * metadata, and the no-JavaScript guarantee. Below the lead title the
 * renderer is total: hostile or unsupported input degrades to visible
 * escaped text, never markup and never a throw, because Publish freezes
 * before it projects and HTML is rebuildable.
 */
import { describe, expect, test } from 'bun:test';

import { type ArkArtifactPage, renderArtifactPage, renderBody } from './render';

const page = (overrides: Partial<ArkArtifactPage> = {}): ArkArtifactPage => ({
	identity: 'braden',
	slug: 'first-artifact',
	publishedOn: '2026-07-20',
	body: '# First Artifact\n\nFrozen words.',
	...overrides,
});

// ============================================================================
// Document shape and metadata
// ============================================================================

describe('renderArtifactPage', () => {
	test('emits one complete semantic document', () => {
		const html = renderArtifactPage(page());
		expect(html).toStartWith('<!doctype html>\n<html lang="en">');
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain('<title>First Artifact · The Ark</title>');
		expect(html).toContain('<main>\n<article>');
		expect(html).toContain('<h1>First Artifact</h1>');
		expect(html).toContain('<p>Frozen words.</p>');
		expect(html).toContain('<footer><a href="/">The Ark</a></footer>');
	});

	test('is deterministic', () => {
		expect(renderArtifactPage(page())).toBe(renderArtifactPage(page()));
	});

	test('the lead H1 is the frozen body: consumed as title, never duplicated', () => {
		const html = renderArtifactPage(page());
		expect(html.match(/First Artifact/g)?.length).toBe(3); // <title>, og:title, <h1>
		expect(html).not.toContain('<h2>First Artifact</h2>');
	});

	test('blank lines before the lead title are tolerated', () => {
		const html = renderArtifactPage(page({ body: '\n\n# Padded\n\nWords.' }));
		expect(html).toContain('<h1>Padded</h1>');
		expect(html).toContain('<p>Words.</p>');
	});

	test('a body without its lead title violates the freeze-gate contract and throws', () => {
		expect(() => renderArtifactPage(page({ body: 'No title here.' }))).toThrow(
			'lead "# Title" heading (Vault ADR-0059)',
		);
		expect(() => renderArtifactPage(page({ body: '## Not a lead' }))).toThrow(
			'Vault ADR-0059',
		);
	});

	test('a whitespace-only or space-led lead title is the same violation, exactly as the Vault gate refuses it', () => {
		expect(() => renderArtifactPage(page({ body: '#  \n\nWords.' }))).toThrow(
			'Vault ADR-0059',
		);
		expect(() =>
			renderArtifactPage(page({ body: '#  Space-led title\n\nWords.' })),
		).toThrow('Vault ADR-0059');
		// Trailing whitespace after a real title stays legal in both gates.
		const html = renderArtifactPage(page({ body: '# Trailing  \n\nWords.' }));
		expect(html).toContain('<h1>Trailing</h1>');
	});

	test('inline markup in the lead title is not interpreted', () => {
		const html = renderArtifactPage(
			page({ body: '# A *literal* title\n\nWords.' }),
		);
		expect(html).toContain('<h1>A *literal* title</h1>');
		expect(html).toContain('<title>A *literal* title · The Ark</title>');
	});

	test('canonical and OG metadata are static tags with the permalink', () => {
		const html = renderArtifactPage(page({ subtitle: 'A subtitle' }));
		expect(html).toContain(
			'<link rel="canonical" href="https://theark.so/braden/first-artifact">',
		);
		expect(html).toContain('<meta property="og:type" content="article">');
		expect(html).toContain(
			'<meta property="og:title" content="First Artifact">',
		);
		expect(html).toContain(
			'<meta property="og:url" content="https://theark.so/braden/first-artifact">',
		);
		expect(html).toContain(
			'<meta property="og:description" content="A subtitle">',
		);
		expect(html).toContain(
			'<meta property="article:published_time" content="2026-07-20">',
		);
	});

	test('description and og:description exist only when a subtitle does', () => {
		const html = renderArtifactPage(page());
		expect(html).not.toContain('name="description"');
		expect(html).not.toContain('og:description');
	});

	test('og:image is absolute and exists only when a cover does', () => {
		const withCover = renderArtifactPage(page({ media: { cover: true } }));
		expect(withCover).toContain(
			'<meta property="og:image" content="https://theark.so/braden/first-artifact/cover.png">',
		);
		expect(renderArtifactPage(page())).not.toContain('og:image');
	});

	test('the only stylesheet is the shared deploy-time theme', () => {
		const html = renderArtifactPage(page());
		const links = html.match(/<link rel="stylesheet"[^>]*>/g);
		expect(links).toEqual([
			'<link rel="stylesheet" href="/assets/theark.css">',
		]);
		expect(html).not.toContain('style=');
	});

	test('date renders as prose with a machine datetime, without Date parsing', () => {
		const html = renderArtifactPage(page());
		expect(html).toContain('<time datetime="2026-07-20">July 20, 2026</time>');
		const odd = renderArtifactPage(page({ publishedOn: 'someday' }));
		expect(odd).toContain('<time datetime="someday">someday</time>');
	});

	test('resonance shows the diamond only when earned', () => {
		expect(renderArtifactPage(page({ resonant: true }))).toContain(
			'<span class="resonance" aria-hidden="true"></span>',
		);
		expect(renderArtifactPage(page())).not.toContain('resonance');
	});

	test('subtitle renders in the header only when present', () => {
		expect(renderArtifactPage(page({ subtitle: 'Why it matters' }))).toContain(
			'<p class="subtitle">Why it matters</p>',
		);
		expect(renderArtifactPage(page())).not.toContain('class="subtitle"');
	});

	test('title metadata is attribute-escaped', () => {
		const html = renderArtifactPage(
			page({
				body: '# Ampersands & "quotes"\n\nWords.',
				subtitle: '<b>sub</b>',
			}),
		);
		expect(html).toContain(
			'<title>Ampersands &amp; &quot;quotes&quot; · The Ark</title>',
		);
		expect(html).toContain('content="&lt;b&gt;sub&lt;/b&gt;"');
		expect(html).not.toContain('<b>');
	});

	test('short-video artifacts lead with the video, cover as poster', () => {
		const html = renderArtifactPage(
			page({ media: { video: true, narration: true, cover: true } }),
		);
		expect(html).toContain(
			'<video controls playsinline preload="metadata" poster="/braden/first-artifact/cover.png" src="/braden/first-artifact/video.mp4"></video>',
		);
		// Narration ships as an addressable file but earns no player while the
		// video already carries the narration track.
		expect(html).not.toContain('<audio');
	});

	test('video without a cover omits the poster', () => {
		const html = renderArtifactPage(page({ media: { video: true } }));
		expect(html).toContain(
			'<video controls playsinline preload="metadata" src="/braden/first-artifact/video.mp4"></video>',
		);
	});

	test('never emits JavaScript, even from hostile input', () => {
		const html = renderArtifactPage(
			page({
				body: '# <script>alert(1)</script>\n\n<script>alert(2)</script>\n\n[x](javascript:alert(3))',
			}),
		);
		expect(html).not.toContain('<script');
		expect(html).not.toContain('href="javascript');
		// The refused constructs stay visible as escaped literal text.
		expect(html).toContain('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
		expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
		expect(html).toContain('<p>[x](javascript:alert(3))</p>');
	});

	test('route values stay attribute data even when a caller violates the path contract', () => {
		const html = renderArtifactPage(
			page({
				identity: 'braden"><script>alert(1)</script>',
				media: { video: true, cover: true },
			}),
		);
		expect(html).not.toContain('<script>');
		expect(html).toContain(
			'braden&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
		);
	});
});

// ============================================================================
// Markdown subset (body below the lead title)
// ============================================================================

describe('renderBody', () => {
	test('paragraphs split on blank lines, soft wraps join', () => {
		expect(renderBody('one\ntwo\n\nthree')).toBe(
			'<p>one\ntwo</p>\n<p>three</p>',
		);
	});

	test('headings below the lead demote; deeper stays literal', () => {
		expect(renderBody('# Top')).toBe('<h2>Top</h2>');
		expect(renderBody('## Section')).toBe('<h2>Section</h2>');
		expect(renderBody('### Detail')).toBe('<h3>Detail</h3>');
		expect(renderBody('#### Too deep')).toBe('<p>#### Too deep</p>');
		expect(renderBody('# ')).toBe('<p># </p>');
	});

	test('single-level lists render; ordered and unordered stay distinct', () => {
		expect(renderBody('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
		expect(renderBody('1. a\n2. b')).toBe(
			'<ol>\n<li>a</li>\n<li>b</li>\n</ol>',
		);
	});

	test('blockquotes carry paragraphs and keep the frozen words', () => {
		expect(renderBody('> quoted\n> words')).toBe(
			'<blockquote>\n<p>quoted\nwords</p>\n</blockquote>',
		);
	});

	test('fenced code escapes everything and applies no inline transforms', () => {
		expect(renderBody('```\nconst a = "<b>" && *x*;\n```')).toBe(
			'<pre><code>const a = &quot;&lt;b&gt;&quot; &amp;&amp; *x*;</code></pre>',
		);
	});

	test('an unclosed fence consumes the rest as code instead of leaking markup', () => {
		expect(renderBody('```\n<script>')).toBe(
			'<pre><code>&lt;script&gt;</code></pre>',
		);
	});

	test('thematic break', () => {
		expect(renderBody('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr>\n<p>b</p>');
	});

	test('inline code, bold, and italic; code contents stay untransformed', () => {
		expect(renderBody('use `**not bold**` and **bold** and *em*')).toBe(
			'<p>use <code>**not bold**</code> and <strong>bold</strong> and <em>em</em></p>',
		);
	});

	test('https, http, and mailto links become anchors', () => {
		expect(renderBody('[site](https://example.com/a?b=1)')).toBe(
			'<p><a href="https://example.com/a?b=1">site</a></p>',
		);
		expect(renderBody('[mail](mailto:braden@example.com)')).toBe(
			'<p><a href="mailto:braden@example.com">mail</a></p>',
		);
		expect(renderBody('[path](https://example.com/*literal*)')).toBe(
			'<p><a href="https://example.com/*literal*">path</a></p>',
		);
	});

	test('executable and unknown schemes stay escaped literal text', () => {
		expect(renderBody('[x](javascript:alert(1))')).toBe(
			'<p>[x](javascript:alert(1))</p>',
		);
		expect(renderBody('[x](data:text/html,hi)')).toBe(
			'<p>[x](data:text/html,hi)</p>',
		);
		expect(renderBody('[x](/braden)')).toBe('<p>[x](/braden)</p>');
	});

	test('entity-smuggled schemes cannot survive escaping', () => {
		expect(renderBody('[x](&#106;avascript:alert(1))')).toBe(
			'<p>[x](&amp;#106;avascript:alert(1))</p>',
		);
	});

	test('raw HTML is refused by escaping, visibly', () => {
		expect(renderBody('<img src=x onerror=alert(1)>')).toBe(
			'<p>&lt;img src=x onerror=alert(1)&gt;</p>',
		);
	});

	test('tables are refused: literal escaped lines, revisit when an artifact needs one', () => {
		expect(renderBody('| a | b |\n| - | - |')).toBe(
			'<p>| a | b |\n| - | - |</p>',
		);
	});

	test('the cover is the only publishable image, root-absolute beside the page', () => {
		expect(
			renderBody('![the cover](cover.png)', '/braden/first-artifact/cover.png'),
		).toBe(
			'<p><img src="/braden/first-artifact/cover.png" alt="the cover"></p>',
		);
		expect(
			renderBody(
				'![*literal alt*](cover.png)',
				'/braden/first-artifact/cover.png',
			),
		).toBe(
			'<p><img src="/braden/first-artifact/cover.png" alt="*literal alt*"></p>',
		);
	});

	test('image references outside the generated set stay literal', () => {
		expect(renderBody('![shot](/assets/CleanShot.jpg)')).toBe(
			'<p>![shot](/assets/CleanShot.jpg)</p>',
		);
		// Even cover.png stays literal when the publication has no cover.
		expect(renderBody('![alt](cover.png)')).toBe('<p>![alt](cover.png)</p>');
	});
});
