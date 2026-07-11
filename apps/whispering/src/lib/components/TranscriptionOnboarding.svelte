<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { Link } from '@epicenter/ui/link';
	import { Separator } from '@epicenter/ui/separator';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation } from '@tanstack/svelte-query';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { environment } from '#runtime';
	import { whisperingPath } from '$lib/constants/urls';
	import {
		TRANSCRIPTION_PROVIDERS,
		type TranscriptionProviderEntry,
	} from '$lib/services/transcription/provider-ui';
	import { getSelectedTranscriptionProvider } from '$lib/settings/transcription-validation';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import LocalModelOnboarding from './LocalModelOnboarding.svelte';
	import ProviderConfigFields from './settings/ProviderConfigFields.svelte';

	type RemoteProvider = Exclude<
		TranscriptionProviderEntry,
		{ access: 'onDevice' }
	>;

	const hasLocal = environment.transcription.providers.includes('local');
	const availableRemoteProviders = TRANSCRIPTION_PROVIDERS.filter(
		(provider): provider is RemoteProvider =>
			provider.access !== 'onDevice' &&
			environment.transcription.providers.includes(provider.id),
	);
	const selectedProvider = $derived(getSelectedTranscriptionProvider());
	const sessionProvider = availableRemoteProviders.find(
		(provider) => provider.access === 'session',
	);
	const availableDirectProviders = availableRemoteProviders.filter(
		(provider) =>
			provider.access === 'key' || provider.access === 'endpoint',
	);
	const fallbackKeyProvider =
		availableDirectProviders.find((provider) => provider.id === 'OpenAI') ??
		availableDirectProviders.find((provider) => provider.access === 'key');
	const selectedDirectProvider = $derived(
		(selectedProvider?.access === 'key' ||
			selectedProvider?.access === 'endpoint') &&
			availableDirectProviders.some(
				(provider) => provider.id === selectedProvider?.id,
			)
			? selectedProvider
			: (fallbackKeyProvider ?? availableDirectProviders[0]),
	);
	const startSignIn = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['transcription-onboarding', 'startSignIn'],
			mutationFn: () => environment.auth.startSignIn(),
		}),
	);

	function chooseLocal() {
		settings.set('transcription.service', 'local');
	}

	function chooseSession() {
		if (sessionProvider) settings.set('transcription.service', sessionProvider.id);
	}

	function chooseDirectProvider() {
		if (selectedDirectProvider) {
			settings.set('transcription.service', selectedDirectProvider.id);
		}
	}
</script>

{#snippet directProviderSetup()}
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">
				Connect {selectedDirectProvider?.label ?? 'a transcription provider'}
			</Card.Title>
			<Card.Description>
				Your audio is sent directly to this provider. You can change providers at
				any time.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if selectedDirectProvider?.access === 'key'}
				<div class="space-y-4">
					<ProviderConfigFields
						provider={selectedDirectProvider.id}
						secretsOnly
					/>
					<p class="text-sm text-muted-foreground">
						Prefer another provider?
						<Link href={whisperingPath('/settings/processing')}>
							View all transcription options
						</Link>
					</p>
				</div>
			{:else}
				<Link href={whisperingPath('/settings/processing')}>
					Finish setting up {selectedDirectProvider?.label ?? 'transcription'}
				</Link>
			{/if}
		</Card.Content>
	</Card.Root>
{/snippet}

{#if hasLocal}
	<LocalModelOnboarding
		bind:value={() => deviceConfig.get('transcription.local.selectedModel'),
		(value) => deviceConfig.set('transcription.local.selectedModel', value)}
		onActivate={chooseLocal}
	/>
{:else}
	<section class="w-full space-y-6">
		<header class="space-y-1 text-center">
			<h2 class="text-xl font-semibold tracking-tight">Connect transcription</h2>
			<p class="text-sm text-muted-foreground">
				Continue with Epicenter, or use a transcription provider you already
				have.
			</p>
		</header>

		{#if sessionProvider}
			<div class="flex flex-col items-center gap-2">
				{#if startSignIn.error}
					<p class="text-sm text-destructive">{startSignIn.error.message}</p>
				{/if}
				<Button
					size="lg"
					class="w-full sm:w-auto"
					disabled={startSignIn.isPending}
					onclick={() => {
						chooseSession();
						if (environment.auth.state.status !== 'signed-in') {
							startSignIn.mutate();
						}
					}}
				>
					{#if startSignIn.isPending}
						<Spinner class="size-4" />
					{:else}
						<CloudIcon class="size-4" />
					{/if}
					{startSignIn.isPending
						? 'Connecting to Epicenter...'
						: environment.auth.state.status === 'reauth-required'
							? 'Reconnect Epicenter'
							: 'Continue with Epicenter'}
				</Button>
				<p class="text-xs text-muted-foreground">No API key required.</p>
			</div>

			{#if selectedDirectProvider}
				<Collapsible.Root>
					<div class="flex items-center gap-3">
						<Separator class="flex-1" />
						<Collapsible.Trigger
							onclick={chooseDirectProvider}
							class="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg:last-child]:rotate-180"
						>
							<KeyRoundIcon class="size-4" />
							Use my own provider
							<ChevronDownIcon class="size-4 transition-transform" />
						</Collapsible.Trigger>
						<Separator class="flex-1" />
					</div>
					<Collapsible.Content class="pt-4">
						{@render directProviderSetup()}
					</Collapsible.Content>
				</Collapsible.Root>
			{/if}
		{:else}
			{@render directProviderSetup()}
		{/if}
	</section>
{/if}
