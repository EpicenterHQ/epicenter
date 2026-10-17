import { type CreateRowOf, defineTable, field } from '@epicenter/definition';
import { defineFolder } from '@epicenter/folder';

/**
 * Each capture is `captures/<stem>.md`: `capturedAt` in frontmatter, and a
 * Markdown body holding the capture text and its thoughts. The stem is the
 * file's identity. Thoughts are not rows; `document.ts` reads them from the
 * body.
 *
 * `capturedAt` is an RFC 3339 datetime, so a file written by hand with an
 * offset (`2026-10-01T10:30:00+08:00`) is as valid as the UTC form the app
 * writes.
 */
export const captureDefinition = defineFolder({
	title: 'Capture',
	tables: {
		captures: defineTable({ fields: { capturedAt: field.datetime() } }),
	},
});

export const CAPTURES_TABLE = 'captures';

export type CaptureFields = CreateRowOf<
	typeof captureDefinition.tables.captures
>;
