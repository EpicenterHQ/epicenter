<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { createMutation } from '@tanstack/svelte-query';
	import type { ComponentProps } from 'svelte';
	import { report } from '$lib/report';
	import type { Recording } from '$lib/state/recordings.svelte';
	import { getWhisperingQueries } from '$lib/whispering/context';

	const queries = getWhisperingQueries();

	/**
	 * Downloads a single recording's audio. Shared by the compact row action
	 * (icon-only) and the detail modal toolbar (labelled).
	 */
	let {
		recording,
		variant = 'ghost',
		size = 'icon',
		showLabel = false,
	}: {
		recording: Recording;
		variant?: ComponentProps<typeof Button>['variant'];
		size?: ComponentProps<typeof Button>['size'];
		/** Render the action's text beside the icon (detail modal toolbar). */
		showLabel?: boolean;
	} = $props();

	const downloadRecording = createMutation(
		() => queries.download.downloadRecording.options,
	);

	function download() {
		downloadRecording.mutate(recording, {
			onError: (error) => {
				report.error({
					cause: error,
					title: 'Failed to download recording!',
					description: 'Your recording could not be downloaded.',
				});
			},
			onSuccess: () => {
				report.success({
					title: 'Recording downloaded!',
					description: 'Your recording has been downloaded.',
				});
			},
		});
	}
</script>

<Button tooltip="Download recording" onclick={download} {variant} {size}>
	{#if downloadRecording.isPending}
		<Spinner />
	{:else}
		<DownloadIcon class="size-4" />
	{/if}
	{#if showLabel}Download{/if}
</Button>
