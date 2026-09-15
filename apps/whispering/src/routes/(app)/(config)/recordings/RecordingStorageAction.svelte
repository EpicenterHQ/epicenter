<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CloudDownloadIcon from '@lucide/svelte/icons/cloud-download';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import {
		createMutation,
		createQuery,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { report } from '$lib/report';
	import type { Recording } from '$lib/state/recordings.svelte';
	import {
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();
	const queryClient = useQueryClient();

	let { recording }: { recording: Recording } = $props();

	const availability = createQuery(
		() => queries.audio.availability(() => recording).options,
	);
	const canUseRemote = $derived(app.recordings.remoteAvailable);

	async function invalidateAvailability() {
		await queryClient.invalidateQueries({
			queryKey: ['audio', 'availability', recording.id],
		});
	}

	const upload = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'upload', recording.id],
			mutationFn: () => app.recordings.uploadAudio(recording.id),
			onSuccess: invalidateAvailability,
		}),
	);
	const download = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'download', recording.id],
			mutationFn: () => app.recordings.downloadAudio(recording.id),
			onSuccess: invalidateAvailability,
		}),
	);
	const removeLocal = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'removeLocal', recording.id],
			mutationFn: () => app.recordings.removeLocalAudio(recording.id),
			onSuccess: invalidateAvailability,
		}),
	);
	const pending = $derived(
		upload.isPending || download.isPending || removeLocal.isPending,
	);

</script>

{#if recording.audioBlobId === null}
	<span class="text-muted-foreground text-sm">Audio stays on this device</span>
{:else if availability.data === 'local-only'}
	<Button
		variant="outline"
		size="icon-sm"
		tooltip={canUseRemote ? 'Upload audio' : 'Online audio storage unavailable'}
		disabled={!canUseRemote || pending}
		onclick={() =>
			upload.mutate(undefined, {
				onSuccess: () => report.success({ title: 'Audio uploaded' }),
				onError: (error) =>
					report.error({ title: 'Upload failed', cause: error }),
			})}
	>
		<CloudUploadIcon class="size-4" />
	</Button>
{:else if availability.data === 'remote-only'}
	<Button
		variant="outline"
		size="icon-sm"
		tooltip={canUseRemote
			? 'Download audio'
			: 'Online audio storage unavailable'}
		disabled={!canUseRemote || pending}
		onclick={() =>
			download.mutate(undefined, {
				onSuccess: () => report.success({ title: 'Audio downloaded' }),
				onError: (error) =>
					report.error({ title: 'Download failed', cause: error }),
			})}
	>
		<CloudDownloadIcon class="size-4" />
	</Button>
{:else if availability.data === 'local-and-remote'}
	<Button
		variant="outline"
		size="icon-sm"
		tooltip="Remove audio from this device"
		disabled={!canUseRemote || pending}
		onclick={() =>
			removeLocal.mutate(undefined, {
				onSuccess: () => report.success({ title: 'Local audio removed' }),
				onError: (error) =>
					report.error({
						title: 'Could not remove local audio',
						cause: error,
					}),
			})}
	>
		<TrashIcon class="size-4" />
	</Button>
{/if}
