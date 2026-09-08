<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import { getWhisperingApp } from '$lib/whispering/context';

	// The count comes from cached rows; rendering this surface performs no I/O.
	const app = getWhisperingApp();
	const queryClient = useQueryClient();

	const pending = $derived(app.recordings.backup.pending);

	const backUp = createMutation(() => ({
		mutationKey: ['audio', 'backup', 'kick'],
		mutationFn: () => app.recordings.backup.kick({ refreshLocal: true }),
		onSuccess: (result) => {
			if (result.uploaded > 0) {
				report.success({
					title: `Backed up ${result.uploaded} ${result.uploaded === 1 ? 'recording' : 'recordings'}`,
				});
				// Every row that moved changes its availability badge.
				void queryClient.invalidateQueries({ queryKey: ['audio', 'availability'] });
			}
			if (result.failed > 0) {
				report.info({
					title: `${result.failed} ${result.failed === 1 ? 'recording' : 'recordings'} could not be backed up`,
					description: result.aborted
						? 'Stopped early. Check your connection and sign-in, then try again.'
						: 'They stay on this device. Try again later.',
				});
			}
		},
	}));

	const noun = (count: number) => (count === 1 ? 'recording' : 'recordings');
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
	{#if pending === 0}
		<span>All recordings are backed up to your account.</span>
	{:else}
		<span>{pending} {noun(pending)} not backed up</span>
		<Button
			variant="outline"
			size="sm"
			disabled={backUp.isPending || !app.recordings.remoteAvailable}
			onclick={() => backUp.mutate()}
		>
			<CloudUploadIcon class="size-3.5" />
			{backUp.isPending ? 'Backing up...' : 'Back up now'}
		</Button>
		{#if !app.recordings.remoteAvailable}
			<span>Online backup is unavailable.</span>
		{:else if backUp.data?.absent}
			<span>Last attempt: {backUp.data.absent} {noun(backUp.data.absent)} had no audio on this device.</span>
		{/if}
	{/if}
</div>
