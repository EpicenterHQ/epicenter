<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { createAttachmentStatus } from '$lib/state/recordings.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();
	const status = createAttachmentStatus(app);
	const transfers = $derived(status.current);
	const active = $derived(transfers.items.filter((item) => item.transfer === 'uploading' || item.transfer === 'downloading').length);
	const waiting = $derived(transfers.items.filter((item) => item.transfer === 'waiting').length);
	const failed = $derived(transfers.items.filter((item) => item.transfer === 'failed' || item.presence === 'error').length);
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
	{#if transfers.enabled}
		<span>Audio sync: {active} transferring, {waiting} waiting, {failed} need attention.</span>
		{#if transfers.downloadsPaused}
			<Button variant="outline" size="sm" onclick={() => app.attachments.resumeDownloads()}>Resume downloads</Button>
		{:else}
			<Button variant="outline" size="sm" onclick={() => app.attachments.pauseDownloads()}>Pause downloads</Button>
		{/if}
		<Button variant="outline" size="sm" onclick={() => app.attachments.retry()}>Retry transfers</Button>
	{:else}
		<span>Audio stays in this device's local library.</span>
	{/if}
	<span>Playback uses audio already on this device.</span>
</div>
