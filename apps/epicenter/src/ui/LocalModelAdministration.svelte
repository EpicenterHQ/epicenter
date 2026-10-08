<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import * as Select from '@epicenter/ui/select';
	import type { ModelInfo } from './bindings.gen';
	import { LOCAL_MODEL_UNLOAD_POLICY_OPTIONS } from './local-model-unload-policy';
	import { localModels } from './local-models.svelte';

	/**
	 * Epicenter's local transcription model administration.
	 *
	 * This is the one place a local model is chosen (ADR-0180). Every application
	 * on this device transcribes on whichever model is active here, and none of
	 * them can pick a different one per request, so the choice is stated plainly
	 * rather than buried per app.
	 *
	 * Device-local: the choice names files and an accelerator on this machine, so
	 * it never syncs to another device.
	 */

	const active = $derived(localModels.active);
	const anyDownloaded = $derived(
		localModels.models.some((model) => model.downloaded),
	);
	/** The recommended model; the empty state builds its action around it. */
	const recommended = $derived(
		localModels.models.find((model) => model.recommended) ??
			localModels.models[0],
	);
	const recommendedState = $derived(
		recommended ? localModels.stateOf(recommended) : null,
	);
	const unloadPolicyLabel = $derived(
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.find(
			(option) => option.value === localModels.unloadPolicy,
		)?.label,
	);

	function formatSize(bytes: number | null): string {
		if (!bytes) return '';
		const mb = bytes / 1_000_000;
		return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
	}

	function describe(model: ModelInfo): string {
		const size = formatSize(model.sizeBytes);
		return size ? `${model.description} · ${size}` : model.description;
	}
</script>

<svelte:window onfocus={() => localModels.refresh()} />

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">Local transcription model</Card.Title>
		<Card.Description>
			Epicenter runs every local transcription on one active model. Apps choose
			whether to transcribe locally; this is where you choose what they run on.
			Models live in your shared Hugging Face cache and stay on this device.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if localModels.error}
			<Alert.Root variant="destructive">
				<Alert.Title>Something went wrong</Alert.Title>
				<Alert.Description>{localModels.error}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if active && !active.installed}
			<Alert.Root variant="warning">
				<Alert.Title>{active.name} is active but not downloaded</Alert.Title>
				<Alert.Description>
					Local transcription will fail until you download it again or make
					another model active.
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if !localModels.loaded}
			<p class="text-sm text-muted-foreground">Loading models…</p>
		{:else if !anyDownloaded && recommended && recommendedState}
			<Empty.Root class="py-8">
				<Empty.Title>No local model installed</Empty.Title>
				<Empty.Description>
					Runs on this device: private, offline, and free. Download the
					recommended model to start transcribing.
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
								{recommendedState.cancelling ? 'Cancelling…' : 'Cancel'}
							</Button>
						</div>
					{:else}
						<Button
							onclick={() => localModels.downloadAndActivate(recommended)}
						>
							Download and use {recommended.name} ({formatSize(
								recommended.sizeBytes,
							)})
						</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{/if}

		<Item.Group class="gap-2">
			{#each localModels.models as model (model.id)}
				{@const state = localModels.stateOf(model)}
				{@const isActive = active?.id === model.id}
				<Item.Root variant="outline">
					<Item.Content>
						<Item.Title>
							{model.name}
							{#if isActive}
								<Badge>Active</Badge>
							{:else if model.downloaded}
								<Badge variant="secondary">Downloaded</Badge>
							{/if}
							{#if model.recommended}
								<Badge variant="outline">Recommended</Badge>
							{/if}
						</Item.Title>
						<Item.Description>{describe(model)}</Item.Description>
						{#if state.type === 'downloading' && state.progress > 0}
							<Progress value={state.progress} class="mt-2 h-2" />
						{/if}
					</Item.Content>
					<Item.Actions>
						{#if state.type === 'downloading'}
							<span class="text-sm text-muted-foreground tabular-nums">
								{state.progress}%
							</span>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => localModels.cancel(model)}
								disabled={state.cancelling}
							>
								{state.cancelling ? 'Cancelling…' : 'Cancel'}
							</Button>
						{:else if state.type === 'ready'}
							{#if isActive}
								<Button size="sm" disabled>Active</Button>
							{:else}
								<Button
									size="sm"
									variant="outline"
									onclick={() => localModels.activate(model)}
								>
									Make active
								</Button>
							{/if}
							<Button
								size="sm"
								variant="ghost"
								onclick={() => localModels.remove(model)}
							>
								Delete
							</Button>
						{:else}
							<Button size="sm" onclick={() => localModels.download(model)}>
								Download
							</Button>
						{/if}
					</Item.Actions>
				</Item.Root>
			{/each}
		</Item.Group>

		<div class="space-y-1.5 pt-2">
			<span class="text-sm font-medium" id="unload-policy-label">
				Unload model when idle
			</span>
			<Select.Root
				type="single"
				bind:value={
					() => localModels.unloadPolicy,
					(policy) => localModels.setUnloadPolicy(policy)
				}
			>
				<Select.Trigger
					class="w-full"
					aria-labelledby="unload-policy-label"
				>
					{unloadPolicyLabel ?? 'Select a policy'}
				</Select.Trigger>
				<Select.Content>
					<Select.Group>
						{#each LOCAL_MODEL_UNLOAD_POLICY_OPTIONS as option (option.value)}
							<Select.Item value={option.value} label={option.label}>
								<div class="flex flex-col gap-1 py-1">
									<div class="font-medium">{option.label}</div>
									<div class="text-sm text-muted-foreground">
										{option.description}
									</div>
								</div>
							</Select.Item>
						{/each}
					</Select.Group>
				</Select.Content>
			</Select.Root>
			<p class="text-sm text-muted-foreground">
				When Epicenter drops the loaded model from memory. Lower memory means a
				fresh load on the next transcription.
			</p>
		</div>
	</Card.Content>
</Card.Root>
