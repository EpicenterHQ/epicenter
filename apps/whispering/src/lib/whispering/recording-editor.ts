import { InstantString } from '@epicenter/data/field';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import type { Recording } from './recording.js';
import type { WhisperingRecordings } from './recordings.js';

const fields = ['title', 'recordedAt', 'recordedAtZone', 'transcript'] as const;
export type RecordingEditField = (typeof fields)[number];

type Draft = {
	last: Recording;
	edits: Partial<Record<RecordingEditField, { base: string; value: string }>>;
	polishedBase: string | null;
};

const RecordingEditorError = defineErrors({
	SaveFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not save the recording draft.',
		cause,
	}),
});

/** Session-owned input. Closing a presentation never commits or discards it. */
export function createRecordingEditor(recordings: WhisperingRecordings) {
	const drafts = new Map<Recording['id'], Draft>();
	const listeners = new Set<() => void>();
	let selected: Recording | undefined;
	let isOpen = false;
	let disposed = false;
	const notify = () => {
		for (const listener of listeners) listener();
	};

	function reconcile(id: string, draft: Draft) {
		const current = recordings.get(id);
		if (!current) return;
		draft.last = current;
		for (const field of fields) {
			if (draft.edits[field]?.value === current[field])
				delete draft.edits[field];
		}
		if (Object.keys(draft.edits).length === 0) drafts.delete(id);
	}

	const unsubscribe = recordings.subscribe(() => {
		for (const [id, draft] of drafts) reconcile(id, draft);
		if (selected) selected = recordings.get(selected.id) ?? selected;
		notify();
	});

	function read(id: string) {
		const draft = drafts.get(id);
		const current = recordings.get(id);
		const recording =
			current ?? draft?.last ?? (selected?.id === id ? selected : undefined);
		if (!recording) return;
		const values = {
			title: recording.title,
			recordedAt: String(recording.recordedAt),
			recordedAtZone: recording.recordedAtZone,
			transcript: recording.transcript,
		};
		const conflicts = [];
		for (const field of fields) {
			const edit = draft?.edits[field];
			if (!edit) continue;
			values[field] = edit.value;
			if (
				current &&
				edit.value !== current[field] &&
				(edit.base !== current[field] ||
					(field === 'transcript' &&
						draft.polishedBase !== current.polishedTranscript))
			) {
				conflicts.push({
					field,
					saved: current[field],
					polishedTranscript: current.polishedTranscript,
				});
			}
		}
		return { recording, values, missing: !current, dirty: !!draft, conflicts };
	}

	return {
		get state() {
			return {
				isOpen,
				active: selected ? read(selected.id) : undefined,
				drafts: [...drafts].map(([id, draft]) => ({
					id,
					title:
						(draft.edits.title?.value ?? draft.last.title) ||
						'Untitled recording',
					missing: !recordings.get(id),
				})),
			};
		},
		open(id: string) {
			if (disposed) return;
			const recording = recordings.get(id) ?? drafts.get(id)?.last;
			if (!recording) return;
			selected = recording;
			isOpen = true;
			notify();
		},
		close() {
			isOpen = false;
			notify();
		},
		edit(id: string, field: RecordingEditField, value: string) {
			if (disposed) return;
			const current = recordings.get(id) ?? drafts.get(id)?.last;
			if (!current) return;
			const draft = drafts.get(id) ?? {
				last: current,
				edits: {},
				polishedBase: current.polishedTranscript,
			};
			if (value === current[field]) {
				delete draft.edits[field];
			} else {
				if (field === 'transcript' && !draft.edits.transcript)
					draft.polishedBase = current.polishedTranscript;
				draft.edits[field] = {
					base: draft.edits[field]?.base ?? current[field],
					value,
				};
			}
			if (Object.keys(draft.edits).length) drafts.set(id, draft);
			else drafts.delete(id);
			notify();
		},
		useSaved(id: string, field: RecordingEditField) {
			const draft = drafts.get(id);
			if (!draft || disposed) return;
			delete draft.edits[field];
			if (Object.keys(draft.edits).length === 0) drafts.delete(id);
			notify();
		},
		/** Acknowledge only the saved version actually shown, then recheck at Save. */
		keepDraft(
			id: string,
			conflict: NonNullable<ReturnType<typeof read>>['conflicts'][number],
		) {
			const draft = drafts.get(id);
			const current = recordings.get(id);
			const edit = draft?.edits[conflict.field];
			if (disposed || !current || !draft || !edit) return;
			if (
				current[conflict.field] === conflict.saved &&
				(conflict.field !== 'transcript' ||
					current.polishedTranscript === conflict.polishedTranscript)
			) {
				edit.base = conflict.saved;
				if (conflict.field === 'transcript')
					draft.polishedBase = conflict.polishedTranscript;
			}
			notify();
		},
		discard(id: string) {
			drafts.delete(id);
			if (selected?.id === id && !recordings.get(id)) {
				selected = undefined;
				isOpen = false;
			}
			notify();
		},
		save(
			id: string,
		): Result<
			{ status: 'saved' | 'conflict' | 'invalid-time' | 'missing' | 'closed' },
			InferErrors<typeof RecordingEditorError>
		> {
			if (disposed) return Ok({ status: 'closed' as const });
			const current = recordings.get(id);
			if (!current) return Ok({ status: 'missing' as const });
			const active = read(id)!;
			if (active.conflicts.length) return Ok({ status: 'conflict' as const });
			const draft = drafts.get(id);
			let changes: Parameters<WhisperingRecordings['patch']>[1] = {};
			for (const field of fields) {
				const edit = draft?.edits[field];
				if (!edit || edit.value === current[field]) continue;
				if (field === 'recordedAt') {
					if (!InstantString.is(edit.value))
						return Ok({ status: 'invalid-time' as const });
					changes = { ...changes, recordedAt: edit.value };
				} else changes = { ...changes, [field]: edit.value };
				if (field === 'transcript')
					changes = { ...changes, polishedTranscript: null };
			}
			const result = trySync({
				try: () => {
					if (Object.keys(changes).length) recordings.patch(id, changes);
					drafts.delete(id);
					isOpen = false;
					notify();
					return { status: 'saved' as const };
				},
				catch: (cause) => RecordingEditorError.SaveFailed({ cause }),
			});
			return result;
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			drafts.clear();
			selected = undefined;
			isOpen = false;
			notify();
			listeners.clear();
		},
	};
}

export type RecordingEditor = ReturnType<typeof createRecordingEditor>;
