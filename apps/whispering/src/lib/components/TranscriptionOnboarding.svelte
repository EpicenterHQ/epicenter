<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Item from '@epicenter/ui/item';
	import { Link } from '@epicenter/ui/link';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import { createMutation } from '@tanstack/svelte-query';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import CpuIcon from '@lucide/svelte/icons/cpu';
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
	const fallbackKeyProvider =
		availableRemoteProviders.find((provider) => provider.id === 'OpenAI') ??
		availableRemoteProviders.find((provider) => provider.access === 'key');
	const selectedRemoteProvider = $derived(
		selectedProvider?.access !== 'onDevice' &&
			availableRemoteProviders.some(
				(provider) => provider.id === selectedProvider?.id,
			)
			? selectedProvider
			: (fallbackKeyProvider ?? availableRemoteProviders[0]),
	);
	const path = $derived.by(() => {
		if (hasLocal) {
			return selectedProvider?.access === 'onDevice' ? 'local' : 'cloud';
		}
		return selectedProvider?.access === 'session' ? 'session' : 'provider';
	});
	const startSignIn = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['transcription-onboarding', 'startSignIn'],
			mutationFn: () => environment.auth.startSignIn(),
		}),
	);

	function chooseLocal() {
		settings.set('transcription.service', 'local');
	}

	function chooseCloud() {
		if (selectedRemoteProvider) {
			settings.set('transcription.service', selectedRemoteProvider.id);
		}
	}

	function chooseSession() {
		if (sessionProvider) settings.set('transcription.service', sessionProvider.id);
	}

	function chooseProvider() {
		if (
			selectedRemoteProvider?.access === 'key' ||
			selectedRemoteProvider?.access === 'endpoint'
		) {
			settings.set('transcription.service', selectedRemoteProvider.id);
		} else if (fallbackKeyProvider) {
			settings.set('transcription.service', fallbackKeyProvider.id);
		}
	}
</script>

<div class="w-full space-y-5">
	<div class="space-y-1 text-center">
		<h2 class="text-xl font-semibold tracking-tight">
			{hasLocal
				? 'Choose where transcription runs'
				: 'Choose how to connect transcription'}
		</h2>
		<p class="text-sm text-muted-foreground">
			{hasLocal
				? 'Keep audio on this device, or send it to a cloud provider you choose.'
				: 'Use your Epicenter account, or connect a transcription provider directly.'}
		</p>
	</div>

	{#if hasLocal}
		<div
			role="group"
			aria-label="Where transcription runs"
			class="grid grid-cols-1 gap-3 sm:grid-cols-2"
		>
			<Item.Button
				variant="outline"
				aria-pressed={path === 'local'}
				onclick={chooseLocal}
				class={cn(
					'h-full min-h-28 w-full flex-col items-start text-left',
					path === 'local'
						? 'border-primary bg-primary/5'
						: 'hover:bg-muted/50',
				)}
			>
				<Item.Content class="w-full">
					<Item.Title class="w-full gap-2">
						<CpuIcon
							class={cn(
								'size-4',
								path === 'local'
									? 'text-primary'
									: 'text-muted-foreground',
							)}
						/>
						<span>On this device</span>
						<Badge variant="outline" class="ml-auto text-xs">Recommended</Badge>
					</Item.Title>
					<Item.Description class="line-clamp-none">
						Private, offline, and free after one model download.
					</Item.Description>
				</Item.Content>
			</Item.Button>

			<Item.Button
				variant="outline"
				aria-pressed={path === 'cloud'}
				onclick={chooseCloud}
				class={cn(
					'h-full min-h-28 w-full flex-col items-start text-left',
					path === 'cloud'
						? 'border-primary bg-primary/5'
						: 'hover:bg-muted/50',
				)}
			>
				<Item.Content class="w-full">
					<Item.Title class="w-full gap-2">
						<CloudIcon
							class={cn(
								'size-4',
								path === 'cloud'
									? 'text-primary'
									: 'text-muted-foreground',
							)}
						/>
						<span>Cloud</span>
					</Item.Title>
					<Item.Description class="line-clamp-none">
						Use {selectedRemoteProvider?.label ?? 'a supported provider'} with an account
						or API key.
					</Item.Description>
				</Item.Content>
			</Item.Button>
		</div>
	{:else}
		<div
			role="group"
			aria-label="How transcription is connected"
			class="grid grid-cols-1 gap-3 sm:grid-cols-2"
		>
			{#if sessionProvider}
				<Item.Button
					variant="outline"
					aria-pressed={path === 'session'}
					onclick={chooseSession}
					class={cn(
						'h-full min-h-28 w-full flex-col items-start text-left',
						path === 'session'
							? 'border-primary bg-primary/5'
							: 'hover:bg-muted/50',
					)}
				>
					<Item.Content class="w-full">
						<Item.Title class="w-full gap-2">
							<CloudIcon
								class={cn(
									'size-4',
									path === 'session'
										? 'text-primary'
										: 'text-muted-foreground',
								)}
							/>
							<span>Epicenter</span>
							<Badge variant="outline" class="ml-auto text-xs">Simplest</Badge>
						</Item.Title>
						<Item.Description class="line-clamp-none">
							Sign in for hosted transcription. No API key needed.
						</Item.Description>
					</Item.Content>
				</Item.Button>
			{/if}

			<Item.Button
				variant="outline"
				aria-pressed={path === 'provider'}
				onclick={chooseProvider}
				class={cn(
					'h-full min-h-28 w-full flex-col items-start text-left',
					path === 'provider'
						? 'border-primary bg-primary/5'
						: 'hover:bg-muted/50',
				)}
			>
				<Item.Content class="w-full">
					<Item.Title class="w-full gap-2">
						<KeyRoundIcon
							class={cn(
								'size-4',
								path === 'provider'
									? 'text-primary'
									: 'text-muted-foreground',
							)}
						/>
						<span>
							{selectedRemoteProvider?.access === 'endpoint'
								? 'Custom server'
								: 'Provider API'}
						</span>
					</Item.Title>
					<Item.Description class="line-clamp-none">
						{selectedRemoteProvider?.access === 'endpoint'
							? `Connect to your ${selectedRemoteProvider.label} endpoint.`
							: `Use ${selectedRemoteProvider?.access === 'key' ? selectedRemoteProvider.label : (fallbackKeyProvider?.label ?? 'your provider')} with your own API key.`}
					</Item.Description>
				</Item.Content>
			</Item.Button>
		</div>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">
				{path === 'local'
					? 'Prepare on-device transcription'
					: `Connect ${selectedRemoteProvider?.label ?? 'a transcription provider'}`}
			</Card.Title>
			<Card.Description>
				{path === 'local'
					? 'Download the recommended model. Whispering manages it and runs transcription locally.'
					: 'Your audio is sent to this provider for transcription. You can change providers at any time.'}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if path === 'local'}
				<LocalModelOnboarding
					bind:value={() =>
						deviceConfig.get('transcription.local.selectedModel'),
						(value) =>
							deviceConfig.set('transcription.local.selectedModel', value)}
				/>
			{:else if selectedRemoteProvider?.access === 'key'}
				<div class="space-y-4">
					<ProviderConfigFields
						provider={selectedRemoteProvider.id}
						secretsOnly
					/>
					<p class="text-sm text-muted-foreground">
						Prefer another provider?
						<Link href={whisperingPath('/settings/processing')}>
							View all transcription options
						</Link>
					</p>
				</div>
			{:else if selectedRemoteProvider?.access === 'session'}
				<div class="space-y-3">
					{#if startSignIn.error}
						<p class="text-sm text-destructive">{startSignIn.error.message}</p>
					{/if}
					<Button
						disabled={startSignIn.isPending}
						onclick={() => startSignIn.mutate()}
					>
						{#if startSignIn.isPending}<Spinner class="size-4" />{/if}
						{environment.auth.state.status === 'reauth-required'
							? 'Reconnect Epicenter'
							: 'Sign in with Epicenter'}
					</Button>
					<p class="text-sm text-muted-foreground">
						Your account supplies hosted transcription and syncs your workspace.
					</p>
				</div>
			{:else}
				<Link href={whisperingPath('/settings/processing')}>
					Finish setting up {selectedRemoteProvider?.label ?? 'transcription'}
				</Link>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
