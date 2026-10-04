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
	import {
		downloadRecordingAudio,
		removeLocalRecordingAudio,
		uploadRecordingAudio,
	} from '$lib/operations/recording-audio';
	import { report } from '$lib/report';
	import { services } from '$lib/services';
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
	const canUseRemote = $derived(services.blobs.remote !== null);

	async function invalidateAvailability() {
		await queryClient.invalidateQueries({
			queryKey: ['audio', 'availability', recording.id],
		});
	}

	const upload = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'upload', recording.id],
			mutationFn: () => uploadRecordingAudio(app, recording),
			onSuccess: invalidateAvailability,
		}),
	);
	const download = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'download', recording.id],
			mutationFn: () => downloadRecordingAudio(app, recording),
			onSuccess: invalidateAvailability,
		}),
	);
	const removeLocal = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordingAudio', 'removeLocal', recording.id],
			mutationFn: () => removeLocalRecordingAudio(app, recording),
			onSuccess: invalidateAvailability,
		}),
	);
	const pending = $derived(
		upload.isPending || download.isPending || removeLocal.isPending,
	);

</script>

{#if availability.data === 'local-only'}
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
