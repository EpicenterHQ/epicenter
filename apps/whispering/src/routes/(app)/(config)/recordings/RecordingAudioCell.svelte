<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createAttachmentStatus } from '$lib/state/recordings.svelte';
	import type { Recording } from '$lib/state/recordings.svelte';
	import RenderAudioUrl from './RenderAudioUrl.svelte';
	import { getWhisperingApp, getWhisperingQueries } from '$lib/whispering/context';

	const queries = getWhisperingQueries();
	const app = getWhisperingApp();
	const status = createAttachmentStatus(app);

	let { recording }: { recording: Recording } = $props();
	const transfer = $derived(status.current.items.find((item) => item.tableName === 'recordings' && item.rowId === recording.id));
	const availability = createQuery(
		() => queries.audio.availability(() => recording).options,
	);
</script>

{#if availability.data === 'local-only'}
	<RenderAudioUrl id={recording.id} audio={recording.audio} />
	{#if transfer?.transfer === 'uploading'}
		<span class="text-muted-foreground text-sm">Saved on this device; uploading</span>
	{:else if transfer?.transfer === 'failed'}
		<span class="text-muted-foreground text-sm">Saved on this device; audio sync needs attention</span>
	{:else if transfer?.transfer === 'waiting'}
		<span class="text-muted-foreground text-sm">Saved on this device; audio sync waiting to retry</span>
	{/if}
{:else if availability.isError || transfer?.presence === 'error'}
	<span class="text-muted-foreground text-sm">Could not check audio on this device</span>
{:else if availability.isPending}
	<Spinner class="size-3.5" aria-label="Checking audio on this device" />
{:else if availability.data}
	<span class="text-muted-foreground text-sm">
		{#if transfer?.transfer === 'downloading'}Downloading audio
		{:else if transfer?.transfer === 'failed'}Audio download failed
		{:else if transfer && status.current.downloadsPaused}Audio downloads paused
		{:else if transfer?.transfer === 'waiting'}Audio not on this device; waiting to retry
		{:else}Not on this device{/if}
	</span>
	{#if transfer && transfer.transfer !== 'downloading' && transfer.transfer !== 'failed'}
		<Button variant="ghost" size="sm" disabled={status.current.downloadsPaused} onclick={() => app.attachments.prioritize('recordings', recording.id)}>Download next</Button>
	{/if}
{/if}
