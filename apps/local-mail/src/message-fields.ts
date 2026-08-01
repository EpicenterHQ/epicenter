import { Buffer } from 'node:buffer';
import type { GmailMessage } from './schema.ts';

/**
 * Projects a Gmail message wire object into the flat scalar fields the mirror
 * stores and the read surface serves: header values (`Subject`/`From`/`To`/
 * `Date`) and the extracted bodies. Two body projections live here because they
 * serve two purposes: `bodyText` is the searchable plain text stored at ingest,
 * and `bodyHtml` is the `text/html` part the detail read derives from the stored
 * resource for rich rendering (unsanitized: see its own doc). Pure functions
 * over `GmailMessage`, so `db.ts` calls them once at ingest and the SQLite file
 * never re-derives them. Kept out of `schema.ts` (which stays only the TypeBox
 * wire shapes) and out of the `db.ts` closure (which owns the open handle and
 * its prepared statements): this is email-format decoding, not wire validation
 * and not SQLite lifecycle, so it has one home of its own.
 *
 * What these functions promise is part of the fact tier's corpus contract:
 * `subject`, `sender`, and `body_text` are stored columns filled from here, so
 * changing what one of them extracts means bumping `FACT_CORPUS_VERSION` in
 * `db.ts`, which rebuilds the fact tables in place and buys a full re-pull
 * (ADR-0198).
 */

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
	body?: { data?: string; attachmentId?: string };
	parts?: GmailMessagePart[];
};

/** The MIME types a reader would show as the message body. */
const BODY_MIME_TYPES = new Set(['text/plain', 'text/html']);

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
 * Whether Gmail put this message's body out of reach: a `text/plain` or
 * `text/html` part whose `MessagePartBody` carries an `attachmentId` instead of
 * inline `data`.
 *
 * Per Gmail's own reference, `attachmentId` is present "when the body data is
 * stored separately" and retrievable only through `messages.attachments.get`;
 * `format=full` does not guarantee inline `data`. That second call is the one
 * Local Mail refuses, because one `messages.get` is the entire per-message
 * budget (ADR-0196). So this is not a fetch trigger and not a partial-sync flag:
 * the row is fully synchronized, and this is what lets the reader say the body
 * lives in Gmail rather than showing an unexplained blank.
 *
 * Narrow on purpose. A message with an inline body and a PDF attached also has
 * an `attachmentId` in the payload, and is not this: only a body part counts.
 */
export function hasExternalizedBody(message: GmailMessage): boolean {
	try {
		const parts = flattenParts(message.payload as GmailMessagePart | undefined);
		return parts.some(
			(part) =>
				BODY_MIME_TYPES.has(part.mimeType?.toLowerCase() ?? '') &&
				!part.body?.data &&
				Boolean(part.body?.attachmentId),
		);
	} catch {
		return false;
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
