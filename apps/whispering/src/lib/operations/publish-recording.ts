import { defineErrors } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import type { Recording } from '../data.js';
import type { WhisperingData } from '../whispering/app.js';

const PublicationError = defineErrors({
	Unconfirmed: ({
		audioBlobId,
		rowId,
		cause,
	}: {
		audioBlobId: Recording['audioBlobId'];
		rowId: string | undefined;
		cause: unknown;
	}) => ({
		message:
			'Audio is saved, but saving its recording has not been confirmed. Finish saving before closing this page.',
		audioBlobId,
		rowId,
		cause,
	}),
});

/** Retain this attempt in the document owner. Never mint another row on retry. */
export function recordingPublication(
	store: Pick<WhisperingData, 'tables' | 'persistence'>,
	values: Parameters<WhisperingData['tables']['recordings']['create']>[0],
	signal: AbortSignal,
) {
	let attempted = false;
	let rowId: string | undefined;
	return () =>
		tryAsync({
			try: async () => {
				signal.throwIfAborted();
				if (!attempted) {
					attempted = true;
					rowId = store.tables.recordings.create(values).id;
				}
				if (!rowId)
					throw new Error(
						'Creation acceptance is uncertain; no row ID was returned. Do not create another row.',
					);
				const row = store.tables.recordings.get(rowId);
				if (!row) {
					const exists = store.tables.recordings.ids().includes(rowId);
					throw new Error(
						exists
							? 'The known row is nonconforming.'
							: 'The known row is missing. It will not be recreated.',
					);
				}
				await store.persistence.flush();
				signal.throwIfAborted();
				if (store.persistence.get() !== 'saved')
					throw new Error('Local persistence is blocked.');
				const persisted = store.tables.recordings.get(rowId);
				if (!persisted || persisted.audioBlobId !== values.audioBlobId)
					throw new Error(
						'The known recording no longer contains the saved audio.',
					);
				return persisted;
			},
			catch: (cause) =>
				PublicationError.Unconfirmed({
					audioBlobId: values.audioBlobId,
					rowId,
					cause,
				}),
		});
}
