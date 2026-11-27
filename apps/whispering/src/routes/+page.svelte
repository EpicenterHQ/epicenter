<!--
	Home: what dictation needs, the recorder, what it records with and where
	the text goes, and the last few takes to copy again. Finding an older
	one is Recordings' job.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import { recordingsQueries, settingsQueries } from '#lib/queries.ts';
	import AddSampleButton from './AddSampleButton.svelte';
	import NeedsCard from './NeedsCard.svelte';
	import RecorderPanel from './RecorderPanel.svelte';
	import RecordingRow from './RecordingRow.svelte';

	const LAST = 5;

	const list = createQuery(() => recordingsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	/** Newest first; the list arrives oldest first. */
	const last = $derived((list.data ?? []).slice(-LAST).reverse());
	const server = $derived(settings.data?.server);
</script>

<svelte:head><title>Whispering</title></svelte:head>

<main class="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
	<NeedsCard />
	<RecorderPanel />
	<p class="text-center text-xs text-muted-foreground">
		{server ? `${server.model} at ${new URL(server.baseUrl).host}` : 'No transcription server'}
		· Copies to the clipboard
		· <a class="underline underline-offset-2 hover:text-foreground" href="/settings/output">Change</a>
	</p>

	{#if last.length}
		<section class="flex flex-col gap-1" aria-labelledby="last-takes">
			<div class="flex items-center px-3">
				<h2 id="last-takes" class="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Last takes
				</h2>
				{#if import.meta.env.DEV}<AddSampleButton />{/if}
				<Button variant="link" size="sm" href="/recordings">All recordings</Button>
			</div>
			{#each last as recording (recording.id)}
				<RecordingRow {recording} copy />
			{/each}
		</section>
	{:else if import.meta.env.DEV}
		<div class="flex justify-center"><AddSampleButton /></div>
	{/if}
</main>
