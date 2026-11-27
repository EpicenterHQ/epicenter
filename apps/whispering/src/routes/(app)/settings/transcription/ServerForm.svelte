<!--
	The transcription server: one form, one Save, which also makes the
	server what transcribes. A preset only fills the fields. There is no
	Test button: the next recording is the test.

	The API key is kept where `servers` keeps it (the Keychain on the
	desktop, the browser's storage in a browser) and is never read back; when
	one is kept for the address's server, the field says so instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { toast } from 'svelte-sonner';
	import { originOf, PRESETS } from '#lib/transcription-server.ts';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import {
		keysMutations,
		keysQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';
	import { servers } from '#lib/platform/index.ts';

	// The layout read the settings before this page opened, so the form starts
	// from what is saved.
	const settings = createQuery(() => settingsQueries.read());
	let baseUrl = $state(settings.data?.['transcription.server.baseUrl'] ?? '');
	let model = $state(settings.data?.['transcription.server.model'] ?? '');
	let key = $state('');
	let saving = $state(false);
	/** Errors show once Save was pressed, and each clears as its field is fixed. */
	let triedToSave = $state(false);

	const origin = $derived(originOf(baseUrl));
	const urlError = $derived(
		triedToSave && !origin ? 'Enter an address that starts with http:// or https://.' : undefined,
	);
	const modelError = $derived(
		triedToSave && !model.trim() ? 'Enter the model the server should use.' : undefined,
	);

	/** Whether a key is kept for `origin`'s server; asked again when the origin changes. */
	const keySaved = createQuery(() => ({ ...keysQueries.has(origin ?? ''), enabled: !!origin }));

	async function save(event: SubmitEvent) {
		event.preventDefault();
		triedToSave = true;
		if (urlError || modelError) return;
		const server = { baseUrl: baseUrl.trim(), model: model.trim() };
		saving = true;
		if (key.trim()) {
			const kept = await runMutation(queryClient, keysMutations.set, {
				baseUrl: server.baseUrl,
				key: key.trim(),
			});
			if (kept.error) {
				saving = false;
				return toastOnError(kept, 'Could not save the API key');
			}
		}
		const saved = await runMutation(queryClient, settingsMutations.update, {
			'transcription.provider': 'server',
			'transcription.server.baseUrl': server.baseUrl,
			'transcription.server.model': server.model,
		});
		saving = false;
		if (saved.error) return toastOnError(saved, 'Could not save the settings');
		key = '';
		toast.success('Saved');
	}

	async function forgetKey() {
		if (!origin) return;
		const forgotten = await runMutation(queryClient, keysMutations.set, { baseUrl: origin, key: '' });
		toastOnError(forgotten, 'Could not remove the API key');
	}
</script>

<form class="flex flex-col gap-6" onsubmit={save} novalidate>
	<Field.Set>
		<Field.Legend>Transcription server</Field.Legend>
		<Field.Description>
			Any server with an OpenAI-compatible transcription endpoint. Each recording is sent to it
			when you stop.
		</Field.Description>
		<Field.Group>
			<Field.Field orientation="horizontal" class="flex-wrap">
				<span class="text-sm text-muted-foreground">Fill in for:</span>
				{#each PRESETS as preset (preset.label)}
					<Button
						variant="outline"
						size="sm"
						onclick={() => {
							baseUrl = preset.baseUrl;
							model = preset.model ?? model;
						}}
					>
						{preset.label}
					</Button>
				{/each}
			</Field.Field>

			<Field.Field data-invalid={urlError ? true : undefined}>
				<Field.Label for="base-url">Server URL</Field.Label>
				<Input
					id="base-url"
					type="url"
					placeholder="https://api.openai.com/v1"
					autocomplete="off"
					spellcheck="false"
					aria-invalid={urlError ? true : undefined}
					bind:value={baseUrl}
				/>
				<Field.Error>{urlError}</Field.Error>
			</Field.Field>

			<Field.Field data-invalid={modelError ? true : undefined}>
				<Field.Label for="model">Model</Field.Label>
				<Input
					id="model"
					placeholder="whisper-1"
					autocomplete="off"
					spellcheck="false"
					aria-invalid={modelError ? true : undefined}
					bind:value={model}
				/>
				<Field.Error>{modelError}</Field.Error>
			</Field.Field>

			<Field.Field>
				<Field.Label for="api-key">API key</Field.Label>
				<Input
					id="api-key"
					type="password"
					autocomplete="off"
					placeholder={keySaved.data ? 'Saved; type to replace' : 'Leave blank for a local server'}
					bind:value={key}
				/>
				<Field.Description>
					Kept in {servers.keyKeptIn} for this server.
					{#if keySaved.data}
						<Button variant="link" size="sm" class="h-auto p-0" onclick={forgetKey}>
							Remove the saved key
						</Button>
					{/if}
				</Field.Description>
			</Field.Field>
		</Field.Group>
	</Field.Set>

	<Button type="submit" class="self-start" disabled={saving}>Save</Button>
</form>
