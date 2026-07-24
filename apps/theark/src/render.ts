/**
 * The Ark's trusted constrained renderer.
 *
 * One pure, total function maps a frozen-artifact-shaped input to one complete
 * semantic HTML document that references only the deploy-time stylesheet
 * (/assets/theark.css) and root-absolute sibling media under the artifact's
 * own permalink subtree. It is deliberately not a Markdown engine: the input
 * subset below is the whole vocabulary, and everything outside it renders as
 * visibly escaped literal source text instead of throwing or emitting markup.
 *
 * Totality below the title is load-bearing: Publish freezes the artifact
 * BEFORE projecting it (Vault ADR-0065), so rejecting frozen content would
 * strand it permanently unpublishable. Degraded output is recoverable:
 * projection HTML is disposable and rebuildable (Vault ADR-0064), so a later
 * renderer improvement plus a rebuild upgrades every published page. The one
 * structural requirement is the lead `# Title` heading that opens the body
 * (Vault ADR-0059: the lead H1 becomes the web title); the Vault freeze gate
 * owns that guarantee for every Ark-bound artifact, so the renderer throwing
 * on its absence asserts a violated upstream contract, exactly like the
 * kernel throwing on an unservable address.
 *
 * The Markdown subset (sized by the 68 frozen artifacts in the Vault):
 * - the lead `# Title` opens the body and is consumed as the page title
 * - below it: paragraphs; `#`/`##` -> h2, `###` -> h3
 * - single-level `-` and `1.` lists
 * - `>` blockquotes
 * - fenced code blocks (no highlighting; contents fully escaped)
 * - `---` thematic breaks
 * - inline `code`, **bold**, *italic*
 * - [text](url) links, https/http/mailto only
 * - ![alt](cover.png) only when the publication actually has a cover
 *
 * Refused, by rendering as escaped literal text: raw HTML, executable or
 * unknown URL schemes, tables, nested lists, deeper headings, and media
 * references outside the fixed generated set. No <script>, no inline styles,
 * no JavaScript of any kind is ever emitted; pages work under the delivery
 * Worker's CSP exactly because there is nothing to block.
 */

/**
 * The frozen expression the renderer projects. The page title is not a field:
 * it is the frozen body's own lead H1 (Vault ADR-0059), so a mutable page-row
 * title can never leak into a frozen permanent page. Facets and byline are
 * deliberately absent: no facet page exists to link to and the identity is
 * already the first URL segment, so neither earns visible behavior yet.
 */
export type ArkArtifactPage = {
	/** Public identity segment, e.g. `braden`. */
	readonly identity: string;
	/** Frozen permalink slug under the identity. */
	readonly slug: string;
	readonly subtitle?: string;
	/**
	 * Calendar date the caller declares for this publication, `YYYY-MM-DD`.
	 * The caller records this same date on the canonical receipt after
	 * publish returns; it is an input to the receipt, not a preexisting fact.
	 */
	readonly publishedOn: string;
	/**
	 * Resonant artifacts show the brick diamond beside the date. Presentation
	 * metadata, not frozen words: a rebuild may legitimately refresh it.
	 */
	readonly resonant?: boolean;
	/**
	 * The exact frozen Markdown-subset body, opening with the lead `# Title`
	 * heading that becomes the page title (Vault ADR-0059).
	 */
	readonly body: string;
	/** Which generated files exist beside the page. */
	readonly media?: ArkMediaSet;
};

/**
 * The complete generated-media vocabulary. The short-video renderer is the
 * only conditional producer and it yields exactly these three files; there is
 * no general upload pipeline to name anything else.
 */
export type ArkMediaSet = {
	readonly video?: boolean;
	readonly narration?: boolean;
	readonly cover?: boolean;
};

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

/** Escape text for both element content and attribute values. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

/**
 * `YYYY-MM-DD` to `July 20, 2026` without Date, so rendering is deterministic
 * and timezone-free. A malformed date degrades to its literal text.
 */
function formatDate(publishedOn: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(publishedOn);
	if (!match) return publishedOn;
	const month = MONTHS[Number(match[2]) - 1];
	if (!month) return publishedOn;
	return `${month} ${Number(match[3])}, ${match[1]}`;
}

/**
 * Closed inline vocabulary. Matching source tokens before emitting tags keeps
 * later emphasis handling away from generated attributes.
 */
const INLINE_PATTERN =
	/`([^`\n]+)`|!\[([^\]\n]*)\]\(cover\.png\)|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]*)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;

/**
 * Parse inline source tokens, then escape at final emission. Generated tags
 * never re-enter another regex transform, so punctuation in an href or image
 * alt cannot manufacture markup inside an attribute.
 */
function renderInline(text: string, coverUrl: string | undefined): string {
	let html = '';
	let cursor = 0;
	for (const match of text.matchAll(INLINE_PATTERN)) {
		const start = match.index;
		html += escapeHtml(text.slice(cursor, start));
		const [source, code, alt, label, url, strong, emphasis] = match;
		if (code !== undefined) {
			html += `<code>${escapeHtml(code)}</code>`;
		} else if (alt !== undefined) {
			html +=
				coverUrl === undefined
					? escapeHtml(source)
					: `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(alt)}">`;
		} else if (label !== undefined && url !== undefined) {
			html += `<a href="${escapeHtml(url)}">${renderInline(label, undefined)}</a>`;
		} else if (strong !== undefined) {
			html += `<strong>${renderInline(strong, undefined)}</strong>`;
		} else if (emphasis !== undefined) {
			html += `<em>${escapeHtml(emphasis)}</em>`;
		} else {
			html += escapeHtml(source);
		}
		cursor = start + source.length;
	}
	return html + escapeHtml(text.slice(cursor));
}

type Block =
	| { kind: 'paragraph' | 'quote'; lines: string[] }
	| { kind: 'code'; lines: string[] }
	| { kind: 'heading'; level: 2 | 3; text: string }
	| { kind: 'list'; ordered: boolean; items: string[] }
	| { kind: 'rule' };

const HEADING_PATTERN = /^(#{1,3}) (.+)$/;

function parseBlocks(body: string): Block[] {
	const lines = body.replaceAll('\r\n', '\n').split('\n');
	const blocks: Block[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim() === '') {
			index += 1;
			continue;
		}

		if (/^```/.test(line)) {
			const code: string[] = [];
			index += 1;
			while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
				code.push(lines[index] ?? '');
				index += 1;
			}
			index += 1; // Consume the closing fence; an unclosed fence eats the rest.
			blocks.push({ kind: 'code', lines: code });
			continue;
		}

		const heading = HEADING_PATTERN.exec(line);
		if (heading) {
			// `#` demotes to h2: the page h1 is the artifact title. `####`+ fails
			// the pattern and stays a literal paragraph.
			blocks.push({
				kind: 'heading',
				level: heading[1] === '###' ? 3 : 2,
				text: heading[2] ?? '',
			});
			index += 1;
			continue;
		}

		if (/^---\s*$/.test(line)) {
			blocks.push({ kind: 'rule' });
			index += 1;
			continue;
		}

		const unordered = /^- (.*)$/;
		const ordered = /^\d+\. (.*)$/;
		if (unordered.test(line) || ordered.test(line)) {
			const isOrdered = ordered.test(line);
			const pattern = isOrdered ? ordered : unordered;
			const items: string[] = [];
			while (index < lines.length) {
				const item = pattern.exec(lines[index] ?? '');
				if (!item) break;
				items.push(item[1] ?? '');
				index += 1;
			}
			blocks.push({ kind: 'list', ordered: isOrdered, items });
			continue;
		}

		if (/^> ?/.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length && /^> ?/.test(lines[index] ?? '')) {
				quoted.push((lines[index] ?? '').replace(/^> ?/, ''));
				index += 1;
			}
			blocks.push({ kind: 'quote', lines: quoted });
			continue;
		}

		const paragraph: string[] = [];
		while (index < lines.length) {
			const current = lines[index] ?? '';
			if (
				current.trim() === '' ||
				/^```/.test(current) ||
				HEADING_PATTERN.test(current) ||
				/^---\s*$/.test(current) ||
				unordered.test(current) ||
				ordered.test(current) ||
				/^> ?/.test(current)
			) {
				break;
			}
			paragraph.push(current);
			index += 1;
		}
		blocks.push({ kind: 'paragraph', lines: paragraph });
	}

	return blocks;
}

function renderParagraphs(
	lines: string[],
	coverUrl: string | undefined,
): string {
	const paragraphs: string[][] = [[]];
	for (const line of lines) {
		if (line.trim() === '') {
			if ((paragraphs.at(-1)?.length ?? 0) > 0) paragraphs.push([]);
		} else {
			paragraphs.at(-1)?.push(line);
		}
	}
	return paragraphs
		.filter((group) => group.length > 0)
		.map((group) => `<p>${renderInline(group.join('\n'), coverUrl)}</p>`)
		.join('\n');
}

function renderBlock(block: Block, coverUrl: string | undefined): string {
	switch (block.kind) {
		case 'paragraph':
			return renderParagraphs(block.lines, coverUrl);
		case 'heading':
			return `<h${block.level}>${renderInline(block.text, coverUrl)}</h${block.level}>`;
		case 'code':
			return `<pre><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`;
		case 'rule':
			return '<hr>';
		case 'list': {
			const tag = block.ordered ? 'ol' : 'ul';
			const items = block.items
				.map((item) => `<li>${renderInline(item, coverUrl)}</li>`)
				.join('\n');
			return `<${tag}>\n${items}\n</${tag}>`;
		}
		case 'quote':
			return `<blockquote>\n${renderParagraphs(block.lines, coverUrl)}\n</blockquote>`;
	}
}

/** Render the frozen Markdown-subset body to article HTML. */
export function renderBody(body: string, coverUrl?: string): string {
	return parseBlocks(body)
		.map((block) => renderBlock(block, coverUrl))
		.filter((html) => html !== '')
		.join('\n');
}

/**
 * The frozen body opens with the lead `# Title` (Vault ADR-0059: the lead H1
 * becomes the web title). The line is consumed as plain text for the visible
 * h1 and the document metadata; it is never re-rendered into the article
 * body, and inline markup inside it is not interpreted. The accepted pattern
 * is character-identical to the Vault freeze gate's own check, so the two
 * gates cannot disagree: the captured title must contain non-whitespace, and
 * a whitespace-only `#  ` heading is the same contract violation here as a
 * missing one, never an empty page title.
 */
function splitLeadTitle(body: string): { title: string; rest: string } {
	const lines = body.replaceAll('\r\n', '\n').split('\n');
	let start = 0;
	while (start < lines.length && (lines[start] ?? '').trim() === '') start += 1;
	const lead = /^# (\S(?:.*\S)?)\s*$/.exec(lines[start] ?? '');
	if (!lead) {
		throw new Error(
			'frozen body must open with its lead "# Title" heading (Vault ADR-0059); the Vault freeze gate owns this guarantee for Ark-bound artifacts',
		);
	}
	return {
		title: lead[1] ?? '',
		rest: lines.slice(start + 1).join('\n'),
	};
}

/**
 * Render the complete artifact page document. The output references only
 * /assets/theark.css plus root-absolute sibling media, carries correct
 * canonical/OG metadata as static tags, and contains no JavaScript. Throws
 * only when the body violates the lead-title contract above.
 */
export function renderArtifactPage(page: ArkArtifactPage): string {
	const canonical = `https://theark.so/${page.identity}/${page.slug}`;
	const mediaBase = `/${page.identity}/${page.slug}`;
	const coverUrl = page.media?.cover ? `${mediaBase}/cover.png` : undefined;

	const { title: leadTitle, rest } = splitLeadTitle(page.body);
	const title = escapeHtml(leadTitle);
	const head = [
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${title} · The Ark</title>`,
		...(page.subtitle
			? [`<meta name="description" content="${escapeHtml(page.subtitle)}">`]
			: []),
		`<link rel="canonical" href="${escapeHtml(canonical)}">`,
		'<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
		'<link rel="stylesheet" href="/assets/theark.css">',
		'<meta property="og:type" content="article">',
		`<meta property="og:title" content="${title}">`,
		`<meta property="og:url" content="${escapeHtml(canonical)}">`,
		...(page.subtitle
			? [
					`<meta property="og:description" content="${escapeHtml(page.subtitle)}">`,
				]
			: []),
		// OG images must be absolute; everything else on the page is
		// root-relative so the document is origin-portable for local preview.
		...(coverUrl
			? [
					`<meta property="og:image" content="${escapeHtml(`https://theark.so${coverUrl}`)}">`,
				]
			: []),
		`<meta property="article:published_time" content="${escapeHtml(page.publishedOn)}">`,
	];

	const header = [
		'<header>',
		`<time datetime="${escapeHtml(page.publishedOn)}">${
			page.resonant ? '<span class="resonance" aria-hidden="true"></span>' : ''
		}${escapeHtml(formatDate(page.publishedOn))}</time>`,
		`<h1>${title}</h1>`,
		...(page.subtitle
			? [`<p class="subtitle">${escapeHtml(page.subtitle)}</p>`]
			: []),
		'</header>',
	];

	// A short-video artifact leads with its video: the video IS the
	// expression; the body below carries the same words as text. The cover
	// doubles as the poster. Narration audio ships as an addressable file but
	// earns no player while the video already carries the narration track.
	const video = page.media?.video
		? [
				'<figure class="artifact-video">',
				`<video controls playsinline preload="metadata"${
					coverUrl ? ` poster="${escapeHtml(coverUrl)}"` : ''
				} src="${escapeHtml(`${mediaBase}/video.mp4`)}"></video>`,
				'</figure>',
			]
		: [];

	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		...head,
		'</head>',
		'<body>',
		'<main>',
		'<article>',
		...header,
		...video,
		renderBody(rest, coverUrl),
		'<footer><a href="/">The Ark</a></footer>',
		'</article>',
		'</main>',
		'</body>',
		'</html>',
		'',
	].join('\n');
}
