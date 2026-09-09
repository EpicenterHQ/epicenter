<script lang="ts">
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import {
		SUPPORTED_LANGUAGES_OPTIONS,
		type SupportedLanguage,
	} from '$lib/constants/languages';
	import { resolve } from '$app/paths';
	import { describeTranscriptionDestinationFromConfig } from '$lib/operations/transcription-target';
	import {
		ACCESS_GROUPS,
		TRANSCRIPTION_PROVIDERS,
		type TranscriptionProviderEntry,
	} from '$lib/services/transcription/provider-ui';
	import {
		PROVIDERS,
		type ProviderAccess,
	} from '$lib/services/transcription/providers';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { getLocalRouteBlocker } from '$lib/settings/transcription-validation';
	import { localRoute } from '$lib/state/local-route.svelte';
	import { recordingActive } from '$lib/state/recording-active.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { auth } from '$lib/auth.svelte.js';
	import { tauri } from '#platform/tauri';
	import AdvancedDisclosure from './AdvancedDisclosure.svelte';
	import ProviderConfigFields from './ProviderConfigFields.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	// The Audio stage of the capture pipeline: the transcription setup catalog.
	// Unlike the recorder switcher, this surface only *sets things up* (sign in,
	// add a key and pick a model, download a GGUF, enter a custom server); you pick
	// which route is active in the recorder popover. So no section writes
	// `transcriptionService`; each just persists its own provider config. The
	// active route is reflected read-only as an "Active" badge for orientation.
	// Like {@link CompletionRuntimeConfig}, it owns its routing surface and takes no
	// props, so the page renders it as `<TranscriptionRuntimeConfig />`.

	const activeService = $derived(app.settings.get('transcriptionService'));

	/** The access family of the currently active route; drives the "Active" badge. */
	const activeAccess = $derived(PROVIDERS[activeService].access);

	const destination = $derived(
		describeTranscriptionDestinationFromConfig({
			service: activeService,
			getDeviceConfig: deviceConfig.get,
			// Session locality follows the bonded deployment. Sign-in status decides
			// usability elsewhere; locality only needs the base URL.
			sessionBaseUrl: auth.connection.baseURL,
		}),
	);

	// Cloud/self-hosted capability is provider-wide (static). Local capability is
	// per-model, read from the host's active model; no active model yet defaults
	// permissive (Whisper-class), and the runtime independently guards what it
	// applies and reports it back. Gates the advanced fields, which apply to
	// whichever route is active.
	// `undefined` while the first host read is in flight, which is neither ready
	// nor blocked and must not flash a warning.
	const localRouteChecked = $derived(localRoute.result !== undefined);
	const localRouteBlocker = $derived(getLocalRouteBlocker());

	const currentServiceCapabilities = $derived(
		activeService === 'local'
			? localRoute.capabilities
			: PROVIDERS[activeService].capabilities,
	);

	const spokenLanguageLabel = $derived(
		SUPPORTED_LANGUAGES_OPTIONS.find(
			(i) => i.value === app.settings.get('transcriptionLanguage'),
		)?.label,
	);

	// The catalog's ordered sections, from the single presentation SSOT. On-device
	// transcribes through Rust, so its section is hidden off Tauri (matching the
	// readiness check); the other families always show, each configurable up front.
	const accessSections = $derived(
		(
			Object.entries(ACCESS_GROUPS) as [
				ProviderAccess,
				(typeof ACCESS_GROUPS)[ProviderAccess],
			][]
		)
			.filter(([access]) => access !== 'onDevice' || tauri)
			.map(([access, meta]) => ({ access, ...meta })),
	);

	/** The keyed providers, one card each; narrowed so `models`/`modelSettingKey` read. */
	type KeyEntry = Extract<TranscriptionProviderEntry, { access: 'key' }>;
	const KEY_ENTRIES = TRANSCRIPTION_PROVIDERS.filter(
		(entry): entry is KeyEntry => entry.access === 'key',
	);

	// Signing in redirects/reloads (Option A), which kills an in-flight browser
	// recording, so lock the action while a capture is active. Account settings
	// owns sign-out; this section only makes the hosted transcription route ready.
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	const accountLocked = $derived(recordingActive(app));
	const openConnection = getConnectionScreen();
</script>

{#snippet renderServiceIcon(entry: TranscriptionProviderEntry)}
	<div
		class={cn(
			'size-4 shrink-0 flex items-center justify-center [&>svg]:size-full',
			entry.invertInDarkMode && 'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
		)}
	>
		{@html entry.icon}
	</div>
{/snippet}

<Field.Group>
	<p class="text-muted-foreground text-sm">{destination.summary}</p>

	{#each accessSections as section (section.access)}
		<section class="space-y-3">
			<div class="flex items-center gap-2">
				<h3 class="text-sm font-medium">{section.heading}</h3>
				<Badge variant="outline" class="text-xs">{section.badge}</Badge>
				{#if activeAccess === section.access}
					<Badge class="text-xs">Active</Badge>
				{/if}
			</div>

			{#if section.access === 'onDevice'}
				{@render onDeviceSection()}
			{:else if section.access === 'session'}
				{@render epicenterSection()}
			{:else if section.access === 'key'}
				<div class="space-y-4">
					{#each KEY_ENTRIES as entry (entry.id)}
						{@render keyProviderCard(entry)}
					{/each}
				</div>
			{:else if section.access === 'endpoint'}
				{@render speachesSection()}
			{/if}
		</section>
	{/each}

	<AdvancedDisclosure>
		<Field.Group>{@render advancedFields()}</Field.Group>
	</AdvancedDisclosure>
</Field.Group>

{#snippet onDeviceSection()}
	<!-- Whispering chooses the transcription route; Epicenter owns which local
	     model runs and administers downloads, deletion, and the unload policy
	     (ADR-0180). This section reports whether the route is ready and hands off
	     to Home; it names no model, because model identity is administration data
	     this app is not given. -->
	<Field.Field orientation="horizontal">
		<Field.Content>
			<Field.Label>On-device transcription</Field.Label>
			<Field.Description>
				{#if !localRouteChecked}
					Checking whether this device can transcribe locally.
				{:else if localRouteBlocker}
					{localRouteBlocker}
				{:else}
					Ready. Epicenter runs local transcription on the model you chose in
					Home, and reports which model produced each transcript.
				{/if}
			</Field.Description>
		</Field.Content>
		{#if localRouteChecked && !localRouteBlocker}
			<Badge variant="secondary" class="text-xs">Ready</Badge>
		{:else if localRouteBlocker}
			<Button
				variant="outline"
				size="sm"
				onclick={() => localRoute.openHomeTranscription()}
			>
				Open Home
			</Button>
		{/if}
	</Field.Field>
{/snippet}

{#snippet epicenterSection()}
	{#if isSignedIn}
		<Field.Field orientation="horizontal">
			<Field.Content>
				<Field.Label>Signed in</Field.Label>
				<Field.Description>
					Your Epicenter account is connected. Manage it in
					<Link href={resolve('/settings/account')}>Account settings</Link>.
				</Field.Description>
			</Field.Content>
			<Badge variant="secondary" class="text-xs">Ready</Badge>
		</Field.Field>
	{:else}
		<Field.Field>
			{#if accountLocked}
				<Field.Description class="text-muted-foreground">
					Stop recording to sign in.
				</Field.Description>
			{/if}
			<Button
				class="w-full sm:w-auto sm:self-start"
				onclick={openConnection}
				disabled={accountLocked}
			>
				{#if auth.state.status === 'reauth-required'}
					Reconnect
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
		</Field.Field>
	{/if}
{/snippet}

{#snippet keyProviderCard(entry: KeyEntry)}
	{@const modelItems = entry.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}))}
	<Card.Root>
		<Card.Header>
			<div class="flex items-center gap-2">
				{@render renderServiceIcon(entry)}
				<Card.Title class="text-base">{entry.label}</Card.Title>
				{#if activeService === entry.id}
					<Badge class="text-xs">Active</Badge>
				{/if}
			</div>
			{#if entry.description}
				<Card.Description>{entry.description}</Card.Description>
			{/if}
		</Card.Header>
		<Card.Content class="space-y-4">
			<ProviderConfigFields provider={entry.id} />

			<Field.Field>
				<Field.Label for="{entry.id}-model">{entry.label} Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={
						() => app.settings.get(entry.modelSettingKey),
						(v) => app.settings.set(entry.modelSettingKey, v)
					}
				>
					<Select.Trigger id="{entry.id}-model" class="w-full">
						{modelItems.find(
							(item) => item.value === app.settings.get(entry.modelSettingKey),
						)?.label ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each modelItems as item}
							<Select.Item value={item.value} label={item.label}>
								<div class="flex flex-col gap-1 py-1">
									<div class="font-medium">{item.name}</div>
									<div class="text-sm text-muted-foreground">
										{item.description}
									</div>
									<Badge variant="outline" class="text-xs">{item.cost}</Badge>
								</div>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				{#if entry.modelsDoc}
					<Field.Description>
						You can find more details about the models in the <Link
							href={entry.modelsDoc.href}
							target="_blank"
							rel="noopener noreferrer"
						>
							{entry.modelsDoc.label}
						</Link>
						.
					</Field.Description>
				{/if}
			</Field.Field>
		</Card.Content>
	</Card.Root>
{/snippet}

{#snippet speachesSection()}
	<div class="space-y-4">
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-lg">Speaches</Card.Title>
				<Card.Description>
					Install Speaches server and configure Whispering. Speaches is the
					successor to faster-whisper-server with improved features and active
					development.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-6">
				<div class="flex gap-3">
					<Button
						href="https://speaches.ai/installation/"
						target="_blank"
						rel="noopener noreferrer"
					>
						Installation Guide
					</Button>
					<Button
						variant="outline"
						href="https://speaches.ai/usage/speech-to-text/"
						target="_blank"
						rel="noopener noreferrer"
					>
						Speech-to-Text Guide
					</Button>
				</div>

				<div class="space-y-4">
					<div>
						<p class="text-sm font-medium">
							<span class="text-muted-foreground">Step 1:</span>
							Install Speaches server
						</p>
						<ul class="ml-6 mt-2 space-y-2 text-sm text-muted-foreground">
							<li class="list-disc">
								Download the necessary docker compose files from the <Link
									href="https://speaches.ai/installation/"
									target="_blank"
									rel="noopener noreferrer"
								>
									installation guide
								</Link>
							</li>
							<li class="list-disc">
								Choose CUDA, CUDA with CDI, or CPU variant depending on your
								system
							</li>
						</ul>
					</div>

					<div>
						<p class="text-sm font-medium mb-2">
							<span class="text-muted-foreground">Step 2:</span>
							Start Speaches container
						</p>
						<CopyablePre
							copyableText="docker compose up --detach"
							variant="code"
						/>
					</div>

					<div>
						<p class="text-sm font-medium">
							<span class="text-muted-foreground">Step 3:</span>
							Download a speech recognition model
						</p>
						<ul class="ml-6 mt-2 space-y-2 text-sm text-muted-foreground">
							<li class="list-disc">
								View available models in the <Link
									href="https://speaches.ai/usage/speech-to-text/"
									target="_blank"
									rel="noopener noreferrer"
								>
									speech-to-text guide
								</Link>
							</li>
							<li class="list-disc">
								Run the following command to download a model:
							</li>
						</ul>
						<div class="mt-2">
							<CopyablePre
								copyableText="uvx speaches-cli model download Systran/faster-distil-whisper-small.en"
								variant="code"
							/>
						</div>
					</div>

					<div>
						<p class="text-sm font-medium">
							<span class="text-muted-foreground">Step 4:</span>
							Configure the settings below
						</p>
						<ul class="ml-6 mt-2 space-y-1 text-sm text-muted-foreground">
							<li class="list-disc">Enter your Speaches server URL</li>
							<li class="list-disc">Enter the model ID you downloaded</li>
						</ul>
					</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Field.Field>
			<Field.Label for="speaches-base-url">Base URL</Field.Label>
			<Input
				id="speaches-base-url"
				placeholder="http://localhost:8000"
				autocomplete="off"
				bind:value={
					() => deviceConfig.get('providers.speaches.endpoint'),
					(value) => deviceConfig.set('providers.speaches.endpoint', value)
				}
			/>
			<Field.Description>
				The URL where your Speaches server is running (<code>
					SPEACHES_BASE_URL
				</code>), typically
				<CopyButton
					text="http://localhost:8000"
					copyFn={createCopyFn('speaches base url')}
					class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
					variant="ghost"
					size="sm"
				>
					http://localhost:8000
				</CopyButton>
			</Field.Description>
		</Field.Field>

		<Field.Field>
			<Field.Label for="speaches-model-id">Model ID</Field.Label>
			<Input
				id="speaches-model-id"
				placeholder="Systran/faster-distil-whisper-small.en"
				autocomplete="off"
				bind:value={
					() => deviceConfig.get('providers.speaches.modelId'),
					(value) => deviceConfig.set('providers.speaches.modelId', value)
				}
			/>
			<Field.Description>
				The model you downloaded in step 3 (<code>MODEL_ID</code>), e.g.
				<CopyButton
					text="Systran/faster-distil-whisper-small.en"
					copyFn={createCopyFn('speaches model id')}
					class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
					variant="ghost"
					size="sm"
				>
					Systran/faster-distil-whisper-small.en
				</CopyButton>
			</Field.Description>
		</Field.Field>
	</div>
{/snippet}

{#snippet advancedFields()}
	<Field.Field>
		<Field.Label for="spoken-language">Spoken Language</Field.Label>
		<Select.Root
			type="single"
			bind:value={
				() => app.settings.get('transcriptionLanguage'),
				(v) => app.settings.set('transcriptionLanguage', v as SupportedLanguage)
			}
			disabled={!currentServiceCapabilities.supportsLanguage}
		>
			<Select.Trigger id="spoken-language" class="w-full">
				{spokenLanguageLabel ?? 'Select a spoken language'}
			</Select.Trigger>
			<Select.Content>
				{#each SUPPORTED_LANGUAGES_OPTIONS as item}
					<Select.Item value={item.value} label={item.label} />
				{/each}
			</Select.Content>
		</Select.Root>
		{#if !currentServiceCapabilities.supportsLanguage}
			<Field.Description>
				This model detects the spoken language automatically.
			</Field.Description>
		{:else}
			<Field.Description>
				Auto lets the provider detect the spoken language. Pick a language only
				when you want to send a specific hint.
			</Field.Description>
		{/if}
	</Field.Field>

	<Field.Field>
		<Field.Label for="transcription-prompt">System Prompt</Field.Label>
		<Textarea
			id="transcription-prompt"
			placeholder="e.g., This is an academic lecture about quantum physics with technical terms like 'eigenvalue' and 'Schrödinger'"
			disabled={!currentServiceCapabilities.supportsPrompt}
			value={app.settings.get('transcriptionPrompt')}
			onblur={(e) => {
				const next = e.currentTarget.value;
				if (next !== app.settings.get('transcriptionPrompt'))
					app.settings.set('transcriptionPrompt', next);
			}}
		/>
		<Field.Description>
			{currentServiceCapabilities.supportsPrompt
				? 'Helps services that support prompts recognize specific terms, names, or context during transcription. For rewriting or translation, use Recipes.'
				: 'This transcription service does not support prompts.'}
		</Field.Description>
	</Field.Field>
{/snippet}
