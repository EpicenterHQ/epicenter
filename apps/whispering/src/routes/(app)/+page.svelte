<!--
	Home: the recorder, anything dictation still needs, and what you said
	last, to read and copy again, with the two takes before it. Finding an
	older one is Recordings' job.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { createQuery } from '@tanstack/svelte-query';
	import { transcriber } from '#lib/data/settings.ts';
	import { getDictation } from '#lib/dictation-view.ts';
	import { formatDuration } from '#lib/feed.ts';
	import { recordingsQueries, settingsQueries } from '#lib/queries.ts';
	import AddSampleButton from './AddSampleButton.svelte';
	import NeedsLine from './NeedsLine.svelte';
	import RecorderPanel from './RecorderPanel.svelte';
	import RecordingRow from './RecordingRow.svelte';

	const dictation = getDictation();
	const list = createQuery(() => recordingsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	/** Newest first; the list arrives oldest first. */
	const recent = $derived((list.data ?? []).slice(-3).reverse());
	const latest = $derived(recent[0]);
	const chosen = $derived(settings.data && transcriber(settings.data));
	const server = $derived(chosen?.kind === 'server' ? chosen : undefined);
	const unmet = $derived(dictation.needs().length > 0);
</script>

<svelte:head><title>Whispering</title></svelte:head>

<main class="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
	<RecorderPanel />

	{#if unmet}
		<NeedsLine />
	{:else if server}
		<p class="text-center text-xs text-muted-foreground">
			{server.model} at {new URL(server.baseUrl).host} · Copies to the clipboard ·
			<a class="underline underline-offset-2 hover:text-foreground" href="/settings/transcription">Change</a>
		</p>
	{/if}

	{#if latest}
		<section class="flex flex-col gap-2" aria-labelledby="latest">
			<div class="flex items-center gap-2 px-3">
				<h2 id="latest" class="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Latest
				</h2>
				{#if import.meta.env.DEV}<AddSampleButton />{/if}
				<Button variant="link" size="sm" href="/recordings">All recordings</Button>
			</div>

			{#if latest.transcript && !dictation.isTranscribing(latest.id)}
				<div class="flex flex-col gap-2 px-3">
					<p class="line-clamp-4 text-base leading-relaxed">{latest.transcript}</p>
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<a class="hover:text-foreground" href="/recordings?id={encodeURIComponent(latest.id)}">
							{latest.at?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
							{#if latest.durationMs !== undefined}· {formatDuration(latest.durationMs)}{/if}
						</a>
						<CopyButton text={latest.transcript} size="sm" variant="ghost" class="ml-auto">Copy</CopyButton>
					</div>
				</div>
			{:else}
				<RecordingRow recording={latest} />
			{/if}

			{#if recent.length > 1}
				<div class="flex flex-col border-t pt-2">
					{#each recent.slice(1) as recording (recording.id)}
						<RecordingRow {recording} copy />
					{/each}
				</div>
			{/if}
		</section>
	{:else if import.meta.env.DEV}
		<div class="flex justify-center"><AddSampleButton /></div>
	{/if}
</main>
