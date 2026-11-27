<!--
	Cleanup's settings: the dictionary, the cleanup model, and its prompt.

	The dictionary applies to every transcript, with or without cleanup: its
	words go to the transcription server as hints, and its replacements fix
	the text that comes back. The cleanup model is a chat model; its server is
	the transcription server unless another address is given, so one provider
	needs one key. Turning cleanup off keeps the model, so turning it back on
	is one click. The dictionary and the prompt are files, each edited by
	`TextFileEditor`.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Switch } from '@epicenter/ui/switch';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { runMutation } from 'wellcrafted/query';
	import { DEFAULT_PROMPT } from '#lib/cleanup.ts';
	import { CLEANUP_PROMPT, DICTIONARY } from '#lib/data/text-files.ts';
	import { servers } from '#lib/platform/index.ts';
	import { keysMutations, queryClient, settingsMutations, settingsQueries } from '#lib/queries.ts';
	import { originOf } from '#lib/transcription-server.ts';
	import SettingsRow from './SettingsRow.svelte';
	import SettingsSection from './SettingsSection.svelte';
	import TextFileEditor from './TextFileEditor.svelte';

	const settings = createQuery(() => settingsQueries.read());

	/** Whether a cleanup model is saved; only then is there something to turn on or off. */
	const saved = $derived(!!settings.data?.['cleanup.model']);
	const enabled = $derived(settings.data?.['cleanup.enabled'] === true);

	let model = $state(settings.data?.['cleanup.model'] ?? '');
	let baseUrl = $state(settings.data?.['cleanup.baseUrl'] ?? '');
	let key = $state('');
	let triedToSave = $state(false);

	const cleanupOrigin = $derived(baseUrl.trim() ? originOf(baseUrl) : undefined);
	/**
	 * The cleanup server's origin when it is not the transcription server's,
	 * whose key the main form keeps: only then does this form ask for a key.
	 */
	const otherOrigin = $derived(
		cleanupOrigin && cleanupOrigin !== originOf(settings.data?.['transcription.server.baseUrl'] ?? '')
			? cleanupOrigin
			: undefined,
	);
	const urlError = $derived(
		triedToSave && baseUrl.trim() && !cleanupOrigin
			? 'Enter an address that starts with http:// or https://, or leave it blank.'
			: undefined,
	);
	const modelError = $derived(
		triedToSave && !model.trim() ? 'Enter the chat model that cleans up.' : undefined,
	);

	async function saveModel(event: SubmitEvent) {
		event.preventDefault();
		triedToSave = true;
		if (urlError || modelError) return;
		if (otherOrigin && key.trim()) {
			const keptKey = await runMutation(queryClient, keysMutations.set, {
				baseUrl: baseUrl.trim(),
				key: key.trim(),
			});
			if (keptKey.error) return toastOnError(keptKey, 'Could not save the API key');
			key = '';
		}
		// Saving a model for the first time turns cleanup on; after that it stays on or off as it was.
		const first = !saved;
		const written = await runMutation(queryClient, settingsMutations.update, {
			'cleanup.model': model.trim(),
			'cleanup.baseUrl': baseUrl.trim(),
			...(first ? { 'cleanup.enabled': true } : {}),
		});
		if (written.error) return toastOnError(written, 'Could not save cleanup');
		toast.success(first ? 'Cleanup is on' : 'Cleanup saved');
	}

	async function setOn(on: boolean) {
		const written = await runMutation(queryClient, settingsMutations.update, {
			'cleanup.enabled': on,
		});
		if (written.error) toastOnError(written, 'Could not change cleanup');
	}
</script>

<TextFileEditor
	path={DICTIONARY}
	legend="Dictionary"
	rows={6}
	placeholder={'Epicenter\nwhisper ring -> Whispering\num ->'}
>
	One entry per line. A word on its own is spelled as written. <code>heard -> written</code>
	replaces what the server wrote, and <code>um -></code> with nothing after the arrow deletes it.
</TextFileEditor>

<form class="flex flex-col gap-3" onsubmit={saveModel} novalidate>
	<SettingsSection
		title="Clean up"
		description="A chat model fixes punctuation, removes filler and false starts, and keeps your words. It is skipped for fewer than four words and when it takes too long; you can always copy the original."
	>
		{#if saved}
			<SettingsRow label="Clean up each transcript" for="cleanup-on">
				<Switch id="cleanup-on" checked={enabled} onCheckedChange={(checked) => setOn(checked)} />
			</SettingsRow>
		{/if}
		<SettingsRow label="Model" for="cleanup-model" error={modelError}>
			<Input
				id="cleanup-model"
				class="w-64 max-w-full"
				placeholder="llama-3.3-70b-versatile"
				autocomplete="off"
				spellcheck="false"
				aria-invalid={modelError ? true : undefined}
				bind:value={model}
			/>
		</SettingsRow>
		<SettingsRow
			label="Server URL"
			description="Leave blank to use the transcription server and its key."
			for="cleanup-url"
			error={urlError}
		>
			<Input
				id="cleanup-url"
				type="url"
				class="w-64 max-w-full"
				placeholder="The transcription server"
				autocomplete="off"
				spellcheck="false"
				aria-invalid={urlError ? true : undefined}
				bind:value={baseUrl}
			/>
		</SettingsRow>
		{#if otherOrigin}
			<SettingsRow label="API key" description="Kept in {servers.keyKeptIn} for this server." for="cleanup-key">
				<Input
					id="cleanup-key"
					type="password"
					class="w-64 max-w-full"
					autocomplete="off"
					placeholder="Blank keeps the saved key"
					bind:value={key}
				/>
			</SettingsRow>
		{/if}
	</SettingsSection>
	<Button type="submit" variant="outline" size="sm" class="self-start">
		{saved ? 'Save model' : 'Turn on cleanup'}
	</Button>
</form>

<TextFileEditor path={CLEANUP_PROMPT} legend="Cleanup prompt" fallback={DEFAULT_PROMPT} rows={12}>
	What the cleanup model is told, kept in cleanup.md once you change it. It is also given your
	dictionary's words.
</TextFileEditor>
