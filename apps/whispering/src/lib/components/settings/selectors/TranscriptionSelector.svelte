<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import * as Empty from '@epicenter/ui/empty';
	import { useCombobox } from '@epicenter/ui/hooks';
	import { Loading } from '@epicenter/ui/loading';
	import * as Popover from '@epicenter/ui/popover';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import { cn } from '@epicenter/ui/utils';
	import CaptionsIcon from '@lucide/svelte/icons/captions';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import HardDriveDownloadIcon from '@lucide/svelte/icons/hard-drive-download';
	import MicIcon from '@lucide/svelte/icons/mic';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { goto } from '$app/navigation';
	import { whisperingPath } from '$lib/constants/urls';
	import { readyModels } from '$lib/settings/transcription-switcher';
	import {
		getSelectedTranscriptionService,
		getTranscriptionReadiness,
	} from '$lib/settings/transcription-validation';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModels } from '$lib/state/local-models.svelte';
	import { auth } from '#platform/auth';
	import { tauri } from '#platform/tauri';
	import ModelRow from './ModelRow.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let {
		class: className,
		variant,
		iconViewTransitionName,
	}: {
		class?: string;
		/**
		 * Where this selector is rendered, which determines how a missing or
		 * unusable transcription service is treated:
		 * - `pipeline`: a required capture stage. Shows the active model's name and
		 *   a captions icon, and warns whenever nothing usable is configured
		 *   (including a web user whose saved service is desktop-only).
		 * - `standalone`: a quick switcher. Shows the active service's brand icon
		 *   and warns only when the selected service is misconfigured.
		 */
		variant: 'standalone' | 'pipeline';
		/** When set, names the trigger's brand glyph for a cross-page view transition. */
		iconViewTransitionName?: string;
	} = $props();

	// The two-source union of routes usable right now (downloaded on-device GGUFs
	// unioned with signed-in session, keyed, and endpoint providers). Each leaf owns
	// its own title, so the trigger just reads the active one.
	const leaves = $derived(readyModels(app));
	const activeLeaf = $derived(leaves.find((leaf) => leaf.isActive));

	const selectedService = $derived(getSelectedTranscriptionService(app));
	const readiness = $derived(getTranscriptionReadiness(app));
	const isSelectedServiceReady = $derived(readiness.isReady);
	const showConfigurationWarning = $derived(
		variant === 'pipeline'
			? !isSelectedServiceReady
			: !!selectedService && !isSelectedServiceReady,
	);

	// The pipeline trigger surfaces the active route's identity as text (an
	// on-device model name, or a provider name), so it reads at a glance instead
	// of relying on a hover tooltip. Exact model ids live in the expanded rows
	// and settings. Falls back to the selected provider's label (when its model
	// is not yet ready), then to a prompt.
	const pipelineLabel = $derived(
		activeLeaf?.title ?? selectedService?.label ?? 'Choose model',
	);

	// The pipeline pill already shows the route's name, so its tooltip describes
	// the action rather than echoing the visible value. The standalone switcher
	// keeps the value, since there it is the brand icon, not text, that is on
	// screen; the exact model id rides along when the route has one.
	const triggerTooltip = $derived.by(() => {
		if (variant === 'pipeline') {
			return selectedService
				? 'Change transcription model'
				: 'Choose transcription model';
		}
		if (activeLeaf) {
			return activeLeaf.modelId
				? `${activeLeaf.title} - ${activeLeaf.modelId}`
				: activeLeaf.title;
		}
		return selectedService
			? selectedService.label
			: 'Select transcription service';
	});

	const combobox = useCombobox();

	// `leaves` is empty only when nothing is set up and the user is signed out
	// (a signed-in user always has the session leaf). Desktop leads with the private
	// on-device download; web offers sign-in or an API key. Never auto-selects a
	// remote provider.
	const recommended = $derived(
		localModels.models.find((model) => model.recommended) ??
			localModels.models[0],
	);
	const recommendedState = $derived(
		recommended ? localModels.stateOf(recommended) : null,
	);

	function formatSize(bytes: number | null): string {
		if (!bytes) return '';
		const mb = bytes / 1_000_000;
		return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
	}

	async function downloadRecommended() {
		if (!recommended) return;
		const result = await localModels.download(recommended);
		if (!result) return;
		if (result.error) {
			toast.error('Failed to download model', {
				description: result.error.message,
			});
			return;
		}
		app.settings.set('transcription.service', 'local');
		deviceConfig.set('transcription.local.selectedModel', result.data.modelId);
		toast.success(
			result.data.outcome === 'already-installed'
				? 'Model already downloaded and activated'
				: 'Model downloaded and activated',
		);
	}
</script>

{#snippet triggerBrandIcon(icon: string, invertInDarkMode: boolean, dimmed = false)}
	<div
		class={cn(
			'size-4 flex items-center justify-center [&>svg]:size-full',
			invertInDarkMode && 'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
			dimmed && 'opacity-60',
		)}
		style:view-transition-name={iconViewTransitionName}
	>
		{@html icon}
	</div>
{/snippet}

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn(
					'relative',
					variant === 'pipeline' && 'min-w-0 flex-1 justify-start',
					className,
				)}
				tooltip={triggerTooltip}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size={variant === 'pipeline' ? 'default' : 'icon'}
			>
				{#if variant === 'pipeline'}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						{#if selectedService}
							{@render triggerBrandIcon(
								selectedService.icon,
								selectedService.invertInDarkMode,
							)}
						{:else}
							<CaptionsIcon class="size-4 text-warning" />
						{/if}
					</span>
					<span
						class={cn(
							'truncate text-sm font-medium',
							!isSelectedServiceReady && 'text-warning',
						)}
					>
						{pipelineLabel}
					</span>
					<ChevronDownIcon
						class="ml-auto size-3.5 shrink-0 text-muted-foreground/70"
					/>
				{:else if selectedService}
					{@render triggerBrandIcon(
						selectedService.icon,
						selectedService.invertInDarkMode,
						!isSelectedServiceReady,
					)}
				{:else}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						<MicIcon class="size-4 text-muted-foreground" />
					</span>
				{/if}
				{#if showConfigurationWarning && variant === 'standalone'}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warning before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-warning/50 before:animate-ping"
					></span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		{#if leaves.length === 0}
			<!-- Signed out with nothing set up: privacy-forward on desktop, remote
			setup on web. Never auto-selects a provider. -->
			{#if tauri && recommended && recommendedState}
				<Empty.Root class="py-8">
					<Empty.Media variant="icon">
						<HardDriveDownloadIcon class="size-5" />
					</Empty.Media>
					<Empty.Title>Transcribe on this device</Empty.Title>
					<Empty.Description>
						Private, offline, and free. Download the recommended model to start.
					</Empty.Description>
					<Empty.Content>
						{#if recommendedState.type === 'downloading'}
							<div class="flex w-full max-w-xs flex-col items-center gap-2">
								<Progress value={recommendedState.progress} class="h-2" />
								<span class="text-sm text-muted-foreground">
									Downloading {recommended.name}: {recommendedState.progress}%
								</span>
								<Button
									variant="ghost"
									size="sm"
									onclick={() => localModels.cancel(recommended)}
									disabled={recommendedState.cancelling}
								>
									<XIcon class="size-4" />
									{recommendedState.cancelling ? 'Cancelling…' : 'Cancel'}
								</Button>
							</div>
						{:else}
							<Button onclick={downloadRecommended}>
								<DownloadIcon class="size-4" />
								Download {recommended.name} ({formatSize(recommended.sizeBytes)})
							</Button>
						{/if}
					</Empty.Content>
				</Empty.Root>
			{:else if tauri && !localModels.loaded}
				<Loading class="py-8" label="Loading on-device models" />
			{:else}
				<Empty.Root class="py-8">
					<Empty.Media variant="icon">
						<MicIcon class="size-5" />
					</Empty.Media>
					<Empty.Title>Set up transcription</Empty.Title>
					<Empty.Description>
						Sign in to Epicenter or add an API key to transcribe. Nothing
						uploads your audio until you choose a provider.
					</Empty.Description>
					<Empty.Content class="flex flex-col gap-2">
						<Button onclick={() => auth.startSignIn()}>Sign in to Epicenter</Button>
						<Button
							variant="outline"
							onclick={() => {
								goto(whisperingPath('/settings/processing'));
								combobox.closeAndFocusTrigger();
							}}
						>
							Add an API key
						</Button>
					</Empty.Content>
				</Empty.Root>
			{/if}
		{:else}
			<Command.Root loop>
				<Command.Input placeholder="Search models..." class="h-9 text-sm" />
				<Command.List class="max-h-[40vh]">
					<Command.Empty>No model found.</Command.Empty>

					{#each leaves as leaf (leaf.key)}
						<ModelRow {leaf} onSelect={combobox.closeAndFocusTrigger} />
					{/each}

					<Command.Separator />
					<Command.Item
						value="add a model settings configure provider"
						onSelect={() => {
							goto(whisperingPath('/settings/processing'));
							combobox.closeAndFocusTrigger();
						}}
						class="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
					>
						<PlusIcon class="size-3.5" />
						Add a model...
					</Command.Item>
				</Command.List>
			</Command.Root>
		{/if}
	</Popover.Content>
</Popover.Root>
