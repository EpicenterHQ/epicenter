import type { Row } from '@epicenter/folder';
import { type Static, Type } from 'typebox';

/**
 * The tables Capture reads from its local folder,
 * `openFolder({ tables: captureTables })`. Each capture is
 * `captures/<stem>.md`: `capturedAt` in frontmatter, and a Markdown body
 * holding the capture text and its thoughts. The stem is its identity.
 * Thoughts are not rows; `document.ts` reads them from completed bodies.
 *
 * `capturedAt` is an RFC 3339 datetime, so a file written by hand with an
 * offset (`2026-10-01T10:30:00+08:00`) is as valid as the UTC form the app
 * writes. The schema only interprets: other frontmatter keys survive an
 * update in canonical form, and a file that does not fit is listed with issues.
 */
export const captureTables = {
	captures: Type.Object({
		capturedAt: Type.String({ format: 'date-time' }),
	}),
};

export const CAPTURES_TABLE = 'captures';

/** The frontmatter of a capture that reads as one. */
export type CaptureFields = Static<(typeof captureTables)['captures']>;

/** A file of the captures table: a capture, or its source and why it is not one. */
export type CaptureRow = Row<(typeof captureTables)['captures']>;
