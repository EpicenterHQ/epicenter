import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booksMirror, type Purchase } from '../mirrors/books.ts';
import { type MailMessage, mailMirror } from '../mirrors/mail.ts';
import {
	MirrorProjectionError,
	type MirrorReaderHandle,
	openMirrorReader,
	openMirrorWriter,
} from '../src/index.ts';

const directories: string[] = [];

function mirrorPath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'mirror-api-'));
	directories.push(directory);
	return join(directory, 'mirror.sqlite3');
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function readerOn<TDeclaration extends Parameters<typeof openMirrorReader>[0]>(
	declaration: TDeclaration,
	file: string,
): MirrorReaderHandle {
	const opened = openMirrorReader(declaration, { path: file });
	if (opened.status !== 'fresh') {
		throw new Error(`expected a fresh mirror, got ${opened.status}`);
	}
	return opened;
}

// --- the simple declaration -------------------------------------------------

describe('a fully declarative projection', () => {
	const sample: Purchase = {
		Id: '101',
		MetaData: { LastUpdatedTime: '2026-07-01T00:00:00Z' },
		TotalAmt: 42.5,
		PaymentType: 'CreditCard',
		AccountRef: { value: '7', name: 'Software' },
	};

	test('paths land in columns, and an absent optional path stores null', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		writer.ingest({
			purchases: [sample, { ...sample, Id: '102', AccountRef: undefined }],
		});
		using reader = readerOn(booksMirror, file);
		expect(
			reader.query(
				'SELECT _key, total, paymentType, accountName FROM purchases ORDER BY _key',
			),
		).toEqual([
			{
				_key: '101',
				total: 42.5,
				paymentType: 'CreditCard',
				accountName: 'Software',
			},
			{
				_key: '102',
				total: 42.5,
				paymentType: 'CreditCard',
				accountName: null,
			},
		]);
	});

	test('a tombstone keeps identity and version, and drops the payload', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		writer.ingest({ purchases: [sample] });
		const report = writer.ingest({
			purchases: [
				{
					...sample,
					MetaData: { LastUpdatedTime: '2026-07-02T00:00:00Z' },
					status: 'Deleted',
				},
			],
		});
		expect(report).toEqual({ applied: 1, rejectedStale: 0, tombstoned: 1 });

		using reader = readerOn(booksMirror, file);
		expect(
			reader.query('SELECT _deleted, _version, total FROM purchases'),
		).toEqual([{ _deleted: 1, _version: '2026-07-02T00:00:00Z', total: null }]);
	});

	test('a projection that violates its declared column fails loudly', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		expect(() =>
			writer.ingest({
				purchases: [{ ...sample, PaymentType: 7 as unknown as string }],
			}),
		).toThrow(MirrorProjectionError);
		expect(() =>
			writer.ingest({
				purchases: [{ ...sample, TotalAmt: undefined as unknown as number }],
			}),
		).toThrow(MirrorProjectionError);
	});
});

// --- the imperative declaration ---------------------------------------------

function message(overrides: Partial<MailMessage> = {}): MailMessage {
	return {
		id: 'm1',
		threadId: 't1',
		historyId: 100,
		labelIds: ['INBOX', 'UNREAD'],
		internalDate: '1750000000000',
		payload: {
			mimeType: 'multipart/mixed',
			headers: [
				{ name: 'From', value: 'a@example.com' },
				{ name: 'Subject', value: 'Invoice' },
			],
			parts: [
				{ partId: '0', mimeType: 'text/plain', body: { size: 12 } },
				{
					partId: '1',
					mimeType: 'multipart/related',
					parts: [
						{
							partId: '1.0',
							mimeType: 'application/pdf',
							filename: 'invoice.pdf',
							body: { attachmentId: 'att-a', size: 900 },
						},
						{
							partId: '1.1',
							mimeType: 'image/png',
							filename: 'logo.png',
							body: { attachmentId: 'att-b', size: 80 },
						},
					],
				},
			],
		},
		...overrides,
	};
}

describe('an imperative derived projection', () => {
	test('one authority object fans out into rows no path could reach', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest(
			{ messages: [message()] },
			{ cursor: '100', full: ['messages'] },
		);

		using reader = readerOn(mailMirror, file);
		expect(reader.query('SELECT subject, threadId FROM messages')).toEqual([
			{ subject: 'Invoice', threadId: 't1' },
		]);
		expect(
			reader.query(
				'SELECT _source, attachmentId, filename, size FROM attachments ORDER BY attachmentId',
			),
		).toEqual([
			{
				_source: 'm1',
				attachmentId: 'att-a',
				filename: 'invoice.pdf',
				size: 900,
			},
			{ _source: 'm1', attachmentId: 'att-b', filename: 'logo.png', size: 80 },
		]);
		expect(
			reader
				.query<{ labelId: string }>(
					'SELECT labelId FROM labels ORDER BY labelId',
				)
				.map((row) => row.labelId),
		).toEqual(['INBOX', 'UNREAD']);
	});

	test('derived rows are scoped to their owner', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest({
			messages: [message(), message({ id: 'm2', labelIds: ['SENT'] })],
		});
		using reader = readerOn(mailMirror, file);
		expect(
			reader.query(
				'SELECT _source, count(*) AS n FROM labels GROUP BY _source ORDER BY _source',
			),
		).toEqual([
			{ _source: 'm1', n: 2 },
			{ _source: 'm2', n: 1 },
		]);
	});

	test('advancing a source replaces its derived set rather than merging it', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest({ messages: [message()] });

		const stripped = message({ historyId: 200, labelIds: ['INBOX'] });
		stripped.payload.parts = [
			{ partId: '0', mimeType: 'text/plain', body: { size: 12 } },
		];
		writer.ingest({ messages: [stripped] });

		using reader = readerOn(mailMirror, file);
		expect(reader.query('SELECT count(*) AS n FROM attachments')).toEqual([
			{ n: 0 },
		]);
		expect(reader.query('SELECT count(*) AS n FROM labels')).toEqual([
			{ n: 1 },
		]);
	});

	test('a tombstoned source owns nothing', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest({ messages: [message()] });
		writer.ingest({
			messages: [message({ historyId: 300, trashed: true })],
		});

		using reader = readerOn(mailMirror, file);
		expect(reader.query('SELECT count(*) AS n FROM attachments')).toEqual([
			{ n: 0 },
		]);
		expect(reader.query('SELECT count(*) AS n FROM labels')).toEqual([
			{ n: 0 },
		]);
		expect(reader.query('SELECT _deleted FROM messages')).toEqual([
			{ _deleted: 1 },
		]);
	});

	test('a numeric version column sorts as a number, not as text', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest({ messages: [message({ historyId: 9 })] });
		// '10' < '9' as text. If the declaration had said lexical, this newer
		// object would have been rejected as stale.
		const report = writer.ingest({ messages: [message({ historyId: 10 })] });
		expect(report.applied).toBe(1);
		using reader = readerOn(mailMirror, file);
		expect(reader.query('SELECT _version FROM messages')).toEqual([
			{ _version: 10 },
		]);
	});
});
