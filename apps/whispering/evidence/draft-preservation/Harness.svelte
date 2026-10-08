<script lang="ts">
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { Ok } from 'wellcrafted/result';
	import { createWhisperingRecordings } from '../../src/lib/whispering/recordings';
	import { createRecordings } from '../../src/lib/state/recordings.svelte';
	import { setWhisperingContext } from '../../src/lib/whispering/context';
	import { createRecordingEditor } from '../../src/lib/whispering/recording-editor';
	import RecordingDetailModal from '../../src/routes/(app)/(config)/recordings/RecordingDetailModal.svelte';
	import RecordingDrafts from '../../src/routes/(app)/(config)/recordings/RecordingDrafts.svelte';
	import RecordingTranscriptCell from '../../src/routes/(app)/(config)/recordings/RecordingTranscriptCell.svelte';

	// The fixture table reproduces full-table invalidation. The domain cache,
	// Svelte adapter, transcript cell, detail form, and shared modal are real.
	let rows = ['a', 'b'].map((id) => ({
		id,
		audioBlobId: 'blob_000000000000000000000',
		title: `Recording ${id.toUpperCase()}`,
		recordedAt: '2026-10-08T00:00:00.000Z',
		recordedAtZone: 'UTC',
		transcript: `Saved transcript ${id.toUpperCase()}`,
		polishedTranscript: null,
		duration: null,
		uploadedAt: null,
		transcriptionStatus: 'completed',
		transcriptionCompletedAt: null,
		transcriptionError: null,
	}));
	const listeners = new Set<() => void>();
	const table = {
		get rows() { return rows.map((row) => ({ ...row })); },
		nonconforming: [],
		get(id: string) { return rows.find((row) => row.id === id); },
		update(id: string, changes: Record<string, unknown>) {
			rows = rows.map((row) => row.id === id ? { ...row, ...changes } : row);
			for (const listener of listeners) listener();
			return Ok(undefined);
		},
		delete(id: string) {
			rows = rows.filter((row) => row.id !== id);
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const domain = createWhisperingRecordings({ table, blobs: { local: {}, remote: null } });
	const recordingEditor = createRecordingEditor(domain.recordings);
	const app = { recordings: createRecordings({ recordings: domain.recordings }) };
	const queries = { audio: { availability: () => ({ options: {
		queryKey: ['fixture-audio'], queryFn: async () => 'unavailable',
	} }) } };
	setWhisperingContext({ app, queries, recordingEditor });
	const queryClient = new QueryClient();
	let showRows = $state(true);
	const baseline = import.meta.env.VITE_DRAFT_BASELINE === '1';
</script>

<Tooltip.Provider>
<QueryClientProvider client={queryClient}>
	<main class="p-8 space-y-4">
		<h1 class="text-xl">Whispering draft preservation</h1>
		<p>Real recording form and domain cache; fixture table and inert audio actions.</p>
		{#if !baseline}<RecordingDrafts />{/if}
		{#if showRows}
		<RecordingTranscriptCell recordingId="a" />
		<RecordingTranscriptCell recordingId="b" />
		{/if}
		<p>Saved A: {app.recordings.get('a')?.transcript}</p>
		<p>Saved A title: {app.recordings.get('a')?.title}</p>
		<p>Schedule B's update, open A, then edit its transcript within five seconds.</p>
		<button class="border p-2" onclick={() => setTimeout(() => app.recordings.patch('b', { title: 'B updated elsewhere' }), 5000)}>Schedule unrelated B update</button>
		<button class="border p-2" onclick={() => setTimeout(() => app.recordings.patch('a', { transcript: 'New saved transcript A' }), 5000)}>Schedule incoming A transcript</button>
		<button class="border p-2" onclick={() => setTimeout(() => app.recordings.patch('a', { polishedTranscript: 'New delivered version A' }), 5000)}>Schedule incoming A polish</button>
		<button class="border p-2" onclick={() => setTimeout(() => { showRows = false; }, 5000)}>Schedule row unmount</button>
		<button class="border p-2" onclick={() => setTimeout(() => table.delete('a'), 5000)}>Schedule A deletion</button>
		<button class="border p-2" onclick={() => { showRows = !showRows; }}>Toggle rows</button>
	</main>
	{#if !baseline}<RecordingDetailModal />{/if}
	<ConfirmationDialog />
</QueryClientProvider>
</Tooltip.Provider>
