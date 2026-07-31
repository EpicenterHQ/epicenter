import { getCollection } from 'astro:content';
import { absoluteUrl } from '../lib/site';

/**
 * The sitemap, generated rather than hand-maintained, because a hand-written
 * one goes stale silently and a stale sitemap is worse than none.
 *
 * Article pages are deliberately absent. Each one canonicalizes to
 * bradenwong.com, and asking a search engine to crawl a copy while telling it
 * the original is authoritative is a contradiction: the canonical link is the
 * claim, and the sitemap should not argue with it. The writing index is
 * included, since that page is genuinely ours.
 *
 * `changefreq` and `priority` are omitted on purpose. Google has said for years
 * that it ignores both, so they would be decoration that implies precision the
 * site does not have.
 */
export async function GET() {
	const articles = await getCollection('writing');

	/** The newest release round is the last time this index genuinely changed. */
	const writingUpdated = articles
		.map((article) => article.data.approvedOn)
		.sort()
		.at(-1);

	const pages: { path: string; lastmod?: string }[] = [
		{ path: '/' },
		{ path: '/writing/', lastmod: writingUpdated },
		{ path: '/whispering' },
		{ path: '/privacy' },
		{ path: '/terms' },
	];

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
	.map(({ path, lastmod }) =>
		[
			'\t<url>',
			`\t\t<loc>${absoluteUrl(path)}</loc>`,
			lastmod ? `\t\t<lastmod>${lastmod}</lastmod>` : null,
			'\t</url>',
		]
			.filter(Boolean)
			.join('\n'),
	)
	.join('\n')}
</urlset>
`;

	return new Response(body, {
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
}
