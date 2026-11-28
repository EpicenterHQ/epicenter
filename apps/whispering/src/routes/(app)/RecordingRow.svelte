<!--
	One recording as a line: its time, length, and the words around a search
	match (or its first words). A recording with no text says so. The line
	links to the recording in Recordings, so the address names the open one.
-->
<script lang="ts">
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import type { Recording } from '#lib/data/recordings.ts';
	import { getDictation } from '#lib/dictation-view.ts';
	import { excerpt, formatDuration } from '#lib/feed.ts';

	let {
		recording,
		query = '',
		selected = false,
		copy = false,
	}: {
		recording: Recording;
		/** The search, whose words the line shows and marks. */
		query?: string;
		selected?: boolean;
		/** Offer Copy at the end of the line. */
		copy?: boolean;
	} = $props();

	const dictation = getDictation();
	const transcribing = $derived(dictation.isTranscribing(recording.id));
	const time = $derived(
		recording.at?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ?? recording.id,
	);
	const length = $derived(recording.durationMs === undefined ? '' : formatDuration(recording.durationMs));
</script>

<div
	class={cn(
		'flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted',
		selected && 'bg-muted',
	)}
>
	<a
		href="/recordings?id={encodeURIComponent(recording.id)}"
		class="flex min-w-0 flex-1 items-baseline gap-3"
		aria-current={selected ? 'true' : undefined}
		data-sveltekit-replacestate={selected || undefined}
		data-sveltekit-reset="false"
	>
		<span class="w-16 shrink-0 tabular-nums text-muted-foreground">{time}</span>
		{#if transcribing}
			<span class="flex items-center gap-2 text-muted-foreground"><Spinner /> Transcribing</span>
		{:else if !recording.transcript}
			<span class="flex items-center gap-2 text-muted-foreground">
				<CircleAlertIcon class="size-4 text-destructive" />
				{recording.audio ? 'Not transcribed' : 'No transcript and no audio'}
			</span>
		{:else}
			<span class="min-w-0 flex-1 truncate">
				{#each excerpt(recording.transcript, query) as part}
					{#if part.hit}<mark class="rounded-sm bg-yellow-500/30 text-inherit">{part.text}</mark>{:else}{part.text}{/if}
				{/each}
			</span>
		{/if}
		<span class="ml-auto shrink-0 tabular-nums text-muted-foreground">{length}</span>
	</a>
	{#if copy && recording.transcript}
		<CopyButton text={recording.transcript} size="sm" variant="ghost">Copy</CopyButton>
	{/if}
</div>
