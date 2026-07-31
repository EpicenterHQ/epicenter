/**
 * The hard case: one authority object fans out into rows that no path
 * expression can describe.
 *
 * A Gmail message carries a recursive MIME tree, a header list that is an array
 * of name/value pairs rather than an object, and a label array. Attachments are
 * the leaves of that tree. Walking it is real code, so `derive` takes real code
 * and the declaration says so out loud: `mailMirror.unfingerprintedPaths`
 * reports `derive.messages` and the two computed columns.
 *
 * What the declaration still pins down as data, and therefore fingerprints:
 * which tables exist, which columns they have, that `attachments` and `labels`
 * are *owned by* `messages`, and that `messages` has an imperative derivation at
 * all. Only the body of the walk is invisible to the gate.
 */

import { defineMirror, derived, path, table } from '../src/index.ts';

export type MailPart = {
	partId?: string;
	mimeType: string;
	filename?: string;
	body?: { attachmentId?: string; size: number };
	parts?: MailPart[];
};

export type MailMessage = {
	id: string;
	threadId: string;
	/** Gmail's monotonically increasing history marker. Numeric, not lexical. */
	historyId: number;
	labelIds: string[];
	internalDate: string;
	payload: {
		headers: { name: string; value: string }[];
		parts?: MailPart[];
		mimeType: string;
		filename?: string;
		body?: { attachmentId?: string; size: number };
	};
	trashed?: boolean;
};

function header(message: MailMessage, name: string): string | null {
	const found = message.payload.headers.find(
		(entry) => entry.name.toLowerCase() === name.toLowerCase(),
	);
	return found?.value ?? null;
}

function* walkParts(part: MailPart): Generator<MailPart> {
	yield part;
	for (const child of part.parts ?? []) yield* walkParts(child);
}

export const mailMirror = defineMirror({
	name: 'gmail',
	tables: {
		messages: table<MailMessage>({
			key: path('id'),
			version: { from: path('historyId'), order: 'numeric' },
			tombstone: path('trashed'),
			columns: {
				threadId: { type: 'text', from: path('threadId') },
				internalDate: { type: 'integer', from: (m) => Number(m.internalDate) },
				// A header list is an array of pairs, so no path reaches "Subject".
				// This is a computed column and the declaration admits it.
				subject: {
					type: 'text',
					from: (m) => header(m, 'Subject'),
					nullable: true,
				},
			},
			indexes: [['threadId']],
		}),
		attachments: derived({
			of: 'messages',
			key: 'attachmentId',
			columns: {
				attachmentId: 'text',
				filename: 'text',
				mimeType: 'text',
				size: 'integer',
			},
			indexes: [['mimeType']],
		}),
		labels: derived({
			of: 'messages',
			key: 'labelId',
			columns: { labelId: 'text' },
		}),
	},
	derive: {
		messages(message, emit) {
			for (const part of walkParts(message.payload)) {
				const attachmentId = part.body?.attachmentId;
				if (attachmentId === undefined) continue;
				emit.attachments({
					attachmentId,
					filename: part.filename ?? '(unnamed)',
					mimeType: part.mimeType,
					size: part.body?.size ?? 0,
				});
			}
			for (const labelId of message.labelIds) emit.labels({ labelId });
		},
	},
});
