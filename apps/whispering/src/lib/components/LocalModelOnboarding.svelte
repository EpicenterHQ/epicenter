<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import HardDriveDownloadIcon from '@lucide/svelte/icons/hard-drive-download';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import { environment } from '#runtime';
	import { formatModelSize } from '$lib/utils/local-model-display';

	let {
		value = $bindable(),
		children,
	}: {
		value: string;
		children?: Snippet;
	} = $props();

	const localModels = environment.transcription.localModels;
	const suggested = $derived(
		localModels.models.find((model) => model.id === value && model.downloaded) ??
			localModels.models.find((model) => model.downloaded) ??
			localModels.models.find((model) => model.recommended) ??
			localModels.models[0],
	);
	const state = $derived(suggested ? localModels.stateOf(suggested) : null);
</script>

{#if !localModels.loaded}
	<Empty.Root class="py-8">
		<Empty.Media variant="icon">
			<Spinner class="size-5" />
		</Empty.Media>
		<Empty.Title>Checking local models</Empty.Title>
	</Empty.Root>
{:else if suggested && state}
	<Empty.Root class="py-8">
		<Empty.Media variant="icon">
			<HardDriveDownloadIcon class="size-5" />
		</Empty.Media>
		<Empty.Title>
			{state.type === 'ready'
				? 'Use a downloaded transcription model'
				: 'Download a transcription model'}
		</Empty.Title>
		<Empty.Description>
			{#if state.type === 'ready'}
				{suggested.name} is already downloaded and ready to use privately on this
				device.
			{:else}
				{suggested.name} is the recommended starting point. It runs privately on
				this device and works offline.
			{/if}
		</Empty.Description>
		<Empty.Content>
			{#if state.type === 'downloading'}
				<div class="flex w-full max-w-xs flex-col items-center gap-2">
					<Progress value={state.progress} class="h-2" />
					<span class="text-sm text-muted-foreground">
						Downloading {suggested.name}: {state.progress}%
					</span>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => localModels.cancel(suggested)}
						disabled={state.cancelling}
					>
						<XIcon class="size-4" />
						{state.cancelling ? 'Cancelling...' : 'Cancel'}
					</Button>
				</div>
			{:else}
				<Button
					onclick={async () => {
						const result = await localModels.download(suggested);
						if (!result) return;
						if (result.error) {
							toast.error('Failed to download model', {
								description: result.error.message,
							});
							return;
						}
						value = result.data.modelId;
						toast.success(
							result.data.outcome === 'already-installed'
								? 'Model already downloaded and activated'
								: 'Model downloaded and activated',
						);
					}}
				>
					<DownloadIcon class="size-4" />
					{state.type === 'ready'
						? `Use ${suggested.name}`
						: `Download ${suggested.name} (${formatModelSize(suggested.sizeBytes)})`}
				</Button>
			{/if}
			{#if children}{@render children()}{/if}
		</Empty.Content>
	</Empty.Root>
{:else}
	<Empty.Root class="py-8">
		<Empty.Title>No local models available</Empty.Title>
		<Empty.Description>
			Whispering could not load its local model catalog. Restart Epicenter and
			try again.
		</Empty.Description>
	</Empty.Root>
{/if}
