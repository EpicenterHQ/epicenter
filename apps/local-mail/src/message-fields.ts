import { Buffer } from 'node:buffer';
import type { GmailMessage } from './schema.ts';

/**
 * Projects a Gmail message wire object into the flat scalar fields the mirror
 * stores and the read surface serves: header values (`Subject`/`From`/`To`/
 * `Date`) and the extracted bodies. Two body projections live here because they
 * serve two purposes: `bodyText` is the searchable plain text stored at ingest,
 * and `bodyHtml` is the raw `text/html` the detail read derives from `raw` for
 * rich rendering (unsanitized: see its own doc). Pure functions over
 * `GmailMessage`, so `db.ts` calls them once at ingest and the SQLite file never
 * re-derives them. Kept out of `schema.ts` (which stays only the TypeBox wire shapes) and
 * out of the `db.ts` closure (which owns the open handle and its prepared
 * statements): this is email-format decoding, not wire validation and not
 * SQLite lifecycle, so it has one home of its own.
 */

/**
 * The rebuild tokens for the three columns this file's projections fill.
 *
 * `MIRROR_DECLARATION` describes the mirror's stored shape structurally, so a
 * changed column, type, or `json_extract` path moves the mirror fingerprint on
 * its own. These three columns are different: their values come from the
 * imperative code below, and no structural declaration can see a change in what
 * that code RETURNS. These tokens are that signal, and they are the only
 * hand-maintained input to the fingerprint. Hashing this file's source instead
 * was rejected: reformatting or bundling is not a stored-shape change, and
 * paying a full mailbox re-download for one would be absurd.
 *
 * Bump the entry for every stored column whose value would change for the same
 * Gmail message: a different header behind `sender`, different part preference
 * or tag stripping in `bodyText`, a different case rule in `headerValue`. The
 * bump drops the mirror and re-pulls the mailbox on the next sync, which is the
 * point: the column would otherwise keep values today's code would never have
 * produced.
 *
 * `bodyHtml` has no token on purpose. It is derived from `raw` at read time and
 * never stored, so changing it changes the next read, not the file.
 */
export const STORED_PROJECTIONS = {
	/** `headerValue(message, 'Subject')` */
	subject: 1,
	/** `headerValue(message, 'From')` */
	sender: 1,
	/** `bodyText(message)` */
	bodyText: 1,
} as const;

/** Pull a header value by name (case-insensitive, per RFC 5322). Gmail nests
 * headers as an array, not a dotted path, so this can't be a SQL generated
 * column and is computed once at ingest instead. */
export function headerValue(
	message: GmailMessage,
	name: string,
): string | null {
	const headers = message.payload?.headers ?? [];
	const lower = name.toLowerCase();
	for (const h of headers) {
		if (h.name.toLowerCase() === lower) return h.value;
	}
	return null;
}

/**
 * The MIME part shape `bodyText` walks. `schema.ts` deliberately keeps
 * `payload.parts` as `Type.Any()` (a loose wire boundary: an unread part shape
 * must never fail response validation), so this is the private traversal type
 * that owns the one cast from that loose boundary, right next to the code that
 * reads it. Body extraction stays defensive (optional chaining, `try`/`catch`)
 * precisely because the wire is only shallowly validated.
 */
type GmailMessagePart = {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailMessagePart[];
};

function decodeBase64Url(data: string): string | null {
	try {
		const normalized = data
			.replace(/-/g, '+')
			.replace(/_/g, '/')
			.padEnd(Math.ceil(data.length / 4) * 4, '=');
		return Buffer.from(normalized, 'base64').toString('utf8');
	} catch {
		return null;
	}
}

function flattenParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
	if (!part) return [];
	return [part, ...(part.parts ?? []).flatMap((child) => flattenParts(child))];
}

function stripHtmlTags(html: string): string {
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** Extract a message's plain-text body: prefer a `text/plain` part, else strip
 * tags from `text/html`. Returns null when neither is present or decoding
 * fails, so the read surface never ships raw HTML. */
export function bodyText(message: GmailMessage): string | null {
	try {
		// `payload.parts` is the loose Gmail wire boundary (`Type.Any()` in
		// schema.ts); this is the one cast that reads into it.
		const parts = flattenParts(message.payload as GmailMessagePart | undefined);
		const plain = parts.find(
			(part) =>
				part.mimeType?.toLowerCase() === 'text/plain' && part.body?.data,
		);
		if (plain?.body?.data) return decodeBase64Url(plain.body.data);

		const html = parts.find(
			(part) => part.mimeType?.toLowerCase() === 'text/html' && part.body?.data,
		);
		if (!html?.body?.data) return null;
		const decoded = decodeBase64Url(html.body.data);
		return decoded === null ? null : stripHtmlTags(decoded);
	} catch {
		return null;
	}
}

/**
 * Extract a message's HTML body: the decoded `text/html` part, returned
 * unsanitized. It is named `unsafe` at every boundary it crosses (the read
 * model's and the API's `unsafeBodyHtml`) because email HTML is hostile input:
 * the single UI caller that renders it MUST run it through the sanitizer first.
 * `stripHtmlTags` in `bodyText` is text extraction, not sanitization, so it is
 * no substitute. Returns null when no `text/html` part is present or decoding
 * fails, so the detail pane falls back to `bodyText`.
 */
export function bodyHtml(message: GmailMessage): string | null {
	try {
		// Same loose Gmail wire boundary (`payload.parts` is `Type.Any()`) the
		// `bodyText` traversal reads; this is the one cast that reads into it.
		const parts = flattenParts(message.payload as GmailMessagePart | undefined);
		const html = parts.find(
			(part) => part.mimeType?.toLowerCase() === 'text/html' && part.body?.data,
		);
		return html?.body?.data ? decodeBase64Url(html.body.data) : null;
	} catch {
		return null;
	}
}
