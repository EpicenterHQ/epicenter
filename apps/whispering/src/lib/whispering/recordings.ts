import type {
	NonconformingRowError,
	RecordTableLens,
} from '@epicenter/data/record';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { FinalizedAudio } from '../services/recorder/contract';
import { getAudioExtension } from '../services/transcription/utils';
import type { Recording, RecordingId, recordingsTable } from '../workspace';

export const RecordingDeletionError = defineErrors({
	RowDeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not delete the recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecordingDeletionError = InferErrors<typeof RecordingDeletionError>;

export type CreateRecordingInput = Omit<
	Recording,
	'id' | 'audioMediaType' | 'audioFileName'
> & {
	audio: FinalizedAudio;
};

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: NonconformingRowError[];
	readonly loadError: unknown;
	get(id: Recording['id']): Recording | undefined;
	/** Create the live row and its one write-once audio slot atomically. */
	create(value: CreateRecordingInput): Promise<Recording>;
	update(
		id: Recording['id'],
		partial: Partial<
			Omit<Recording, 'id' | 'audioMediaType' | 'audioFileName'>
		>,
	): Promise<Result<Recording | undefined, NonconformingRowError>>;
	readAudio(id: Recording['id']): Promise<Blob | null>;
	readPlaybackAudio(id: Recording['id']): Promise<Blob | string | null>;
	delete(
		toDelete: Recording['id'] | Recording['id'][],
	): Promise<Result<void, RecordingDeletionError>>;
	refresh(): Promise<void>;
	subscribe(listener: (changedIds: RecordingId[]) => void): () => void;
};

/**
 * The recordings domain owns both scalar row state and the row's immutable
 * audio slot. No second blob identifier or manual remote-copy lifecycle leaks
 * into product code: record sync publishes the row and its blob obligation.
 */
export function createWhisperingRecordings<
	TSource,
	TRead,
	TCreateSource = TSource,
>({
	table,
	prepareAudio,
	materializeAudio,
	readAudio,
	audioUrl,
	reportBackgroundError,
}: {
	table: RecordTableLens<typeof recordingsTable, TSource, TRead, TCreateSource>;
	prepareAudio(audio: FinalizedAudio): TCreateSource;
	materializeAudio(read: TRead): Promise<Blob>;
	readAudio?(id: RecordingId, mediaType: string): Promise<Blob | null>;
	audioUrl?(id: RecordingId): string;
	reportBackgroundError(cause: unknown): void;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: NonconformingRowError[] = [];
	let loadError: unknown = null;
	let refreshGeneration = 0;
	let isDisposed = false;
	let notifyAllOnRefresh = false;
	const pendingChangedIds = new Set<RecordingId>();
	const listeners = new Set<(changedIds: RecordingId[]) => void>();
	const notify = (changedIds: readonly RecordingId[]) => {
		if (changedIds.length === 0) return;
		for (const listener of listeners) listener([...changedIds]);
	};

	function sortRows(unsorted: Recording[]): Recording[] {
		return unsorted.toSorted(
			(left, right) =>
				new Date(right.recordedAt).getTime() -
				new Date(left.recordedAt).getTime(),
		);
	}

	function applyRowToCache(row: Recording) {
		rows = rows.some((existing) => existing.id === row.id)
			? rows.map((existing) => (existing.id === row.id ? row : existing))
			: [...rows, row];
		sorted = sortRows(rows);
		notify([row.id]);
	}

	function removeRowFromCache(id: Recording['id']) {
		rows = rows.filter((row) => row.id !== id);
		sorted = sortRows(rows);
		notify([id]);
	}

	async function refresh({
		rethrow = false,
		changedIds,
	}: {
		rethrow?: boolean;
		changedIds?: readonly string[];
	} = {}) {
		if (changedIds === undefined) notifyAllOnRefresh = true;
		else {
			for (const id of changedIds) pendingChangedIds.add(id as RecordingId);
		}
		refreshGeneration += 1;
		while (!isDisposed) {
			const generation = refreshGeneration;
			try {
				const { rows: nextRows, nonconforming: nextNonconforming } =
					await table.scan();
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				rows = nextRows as Recording[];
				sorted = sortRows(rows);
				nonconforming = nextNonconforming;
				loadError = null;
				const changed = notifyAllOnRefresh
					? rows.map(({ id }) => id)
					: [...pendingChangedIds];
				notifyAllOnRefresh = false;
				pendingChangedIds.clear();
				notify(changed);
			} catch (cause) {
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				loadError = cause;
				const changed = [...pendingChangedIds];
				pendingChangedIds.clear();
				notify(changed);
				if (rethrow) throw cause;
				reportBackgroundError(cause);
			}
			return;
		}
	}

	const unsubscribeRecords = table.subscribe(
		(changedIds) => void refresh({ changedIds }),
	);
	const ready = refresh({ rethrow: true });
	const recordings: WhisperingRecordings = {
		get sorted() {
			return sorted;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},
		get(id) {
			return rows.find((recording) => recording.id === id);
		},
		async create({ audio, ...fields }) {
			const citation = citeAudio(audio);
			const created = (await table.createWithBlob(
				{ ...fields, ...citation },
				prepareAudio(audio),
			)) as Recording;
			if (audio.kind === 'native-capture') {
				try {
					// Admission is already durable at this point. A failed cleanup
					// acknowledgement must not turn the created row into an apparent
					// create failure and invite a duplicate retry.
					await audio.acknowledgeAdmission();
				} catch (cause) {
					reportBackgroundError(cause);
				}
			}
			applyRowToCache(created);
			void refresh();
			return created;
		},
		async update(id, partial) {
			const {
				id: _id,
				audioMediaType: _audioMediaType,
				audioFileName: _audioFileName,
				...changes
			} = partial as Partial<Recording>;
			const result = await table.update(id, changes);
			if (result.error !== null) return result;
			const updated = result.data as Recording | undefined;
			if (updated !== undefined) applyRowToCache(updated);
			void refresh();
			return Ok(updated);
		},
		async readAudio(id) {
			const row = await table.get(id);
			if (row.error !== null) throw row.error;
			if (row.data === undefined) return null;
			if (readAudio !== undefined) {
				return readAudio(id, row.data.audioMediaType);
			}
			const read = await table.blob.get(id);
			if (read === null) return null;
			const bytes = await materializeAudio(read);
			return new Blob([bytes], { type: row.data.audioMediaType });
		},
		async readPlaybackAudio(id) {
			if (audioUrl === undefined) return recordings.readAudio(id);
			const row = await table.get(id);
			if (row.error !== null) throw row.error;
			return row.data === undefined ? null : audioUrl(id);
		},
		async delete(toDelete) {
			const ids = Array.isArray(toDelete) ? toDelete : [toDelete];
			const result = await tryAsync({
				try: async () => {
					for (const id of ids) {
						await table.delete(id);
						removeRowFromCache(id);
					}
				},
				catch: (cause) => RecordingDeletionError.RowDeleteFailed({ cause }),
			});
			void refresh();
			return result.error === null ? Ok(undefined) : result;
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recordings,
		ready,
		dispose() {
			isDisposed = true;
			refreshGeneration += 1;
			unsubscribeRecords();
			listeners.clear();
		},
	};
}

function citeAudio(audio: FinalizedAudio): {
	audioMediaType: string;
	audioFileName: string;
} {
	const audioMediaType =
		audio.kind === 'native-capture'
			? 'audio/wav'
			: audio.bytes.type || 'application/octet-stream';
	const sourceName =
		audio.kind === 'bytes' &&
		'name' in audio.bytes &&
		typeof audio.bytes.name === 'string' &&
		audio.bytes.name.trim() !== ''
			? audio.bytes.name
			: null;
	return {
		audioMediaType,
		audioFileName:
			sourceName ?? `recording.${getAudioExtension(audioMediaType)}`,
	};
}
