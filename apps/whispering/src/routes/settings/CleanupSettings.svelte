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
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { runMutation } from 'wellcrafted/query';
	import { DEFAULT_PROMPT } from '#lib/cleanup.ts';
	import { CLEANUP_PROMPT, DICTIONARY } from '#lib/data/text-files.ts';
	import { servers } from '#lib/platform/index.ts';
	import { keysMutations, queryClient, settingsMutations, settingsQueries } from '#lib/queries.ts';
	import { originOf } from '#lib/transcription-server.ts';
	import TextFileEditor from './TextFileEditor.svelte';

	const settings = createQuery(() => settingsQueries.read());

	const cleanup = $derived(settings.data?.cleanup);

	let model = $state(settings.data?.cleanup?.model ?? '');
	let baseUrl = $state(settings.data?.cleanup?.baseUrl ?? '');
	let key = $state('');
	let triedToSave = $state(false);

	const cleanupOrigin = $derived(baseUrl.trim() ? originOf(baseUrl) : undefined);
	/**
	 * The cleanup server's origin when it is not the transcription server's,
	 * whose key the main form keeps: only then does this form ask for a key.
	 */
	const otherOrigin = $derived(
		cleanupOrigin && cleanupOrigin !== originOf(settings.data?.server?.baseUrl ?? '')
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
		// Saving the model keeps cleanup on or off as it was.
		const saved = await runMutation(queryClient, settingsMutations.update, {
			cleanup: {
				model: model.trim(),
				...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
				...(cleanup?.off ? { off: true } : {}),
			},
		});
		if (saved.error) return toastOnError(saved, 'Could not save cleanup');
		toast.success(cleanup ? 'Cleanup saved' : 'Cleanup is on');
	}

	async function setOn(on: boolean) {
		if (!cleanup) return;
		const { off: _, ...rest } = cleanup;
		const saved = await runMutation(queryClient, settingsMutations.update, {
			cleanup: on ? rest : { ...rest, off: true },
		});
		if (saved.error) toastOnError(saved, 'Could not change cleanup');
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

<form class="flex flex-col gap-6" onsubmit={saveModel} novalidate>
	<Field.Set>
		<Field.Legend>Clean up</Field.Legend>
		<Field.Description>
			A chat model fixes punctuation, removes filler and false starts, and keeps your words. It
			is skipped in terminals and code editors, for fewer than four words, and when it takes too
			long; you can always copy the original.
		</Field.Description>
		<Field.Group>
			{#if cleanup}
				<Field.Field orientation="horizontal">
					<Checkbox
						id="cleanup-on"
						checked={!cleanup.off}
						onCheckedChange={(checked) => setOn(checked === true)}
					/>
					<Field.Label for="cleanup-on">Clean up each transcript</Field.Label>
				</Field.Field>
			{/if}

			<Field.Field data-invalid={modelError ? true : undefined}>
				<Field.Label for="cleanup-model">Model</Field.Label>
				<Input
					id="cleanup-model"
					placeholder="llama-3.3-70b-versatile"
					autocomplete="off"
					spellcheck="false"
					aria-invalid={modelError ? true : undefined}
					bind:value={model}
				/>
				<Field.Error>{modelError}</Field.Error>
			</Field.Field>

			<Field.Field data-invalid={urlError ? true : undefined}>
				<Field.Label for="cleanup-url">Server URL</Field.Label>
				<Input
					id="cleanup-url"
					type="url"
					placeholder="The transcription server"
					autocomplete="off"
					spellcheck="false"
					aria-invalid={urlError ? true : undefined}
					bind:value={baseUrl}
				/>
				<Field.Description>
					Leave blank to use the transcription server and its key.
				</Field.Description>
				<Field.Error>{urlError}</Field.Error>
			</Field.Field>

			{#if otherOrigin}
				<Field.Field>
					<Field.Label for="cleanup-key">API key</Field.Label>
					<Input
						id="cleanup-key"
						type="password"
						autocomplete="off"
						placeholder="Leave blank to keep the saved key, or for a local server"
						bind:value={key}
					/>
					<Field.Description>Kept in {servers.keyKeptIn} for this server.</Field.Description>
				</Field.Field>
			{/if}
		</Field.Group>
	</Field.Set>
	<Button type="submit" variant="outline" class="self-start">
		{cleanup ? 'Save model' : 'Turn on cleanup'}
	</Button>
</form>

<TextFileEditor path={CLEANUP_PROMPT} legend="Cleanup prompt" fallback={DEFAULT_PROMPT} rows={12}>
	What the cleanup model is told, kept in cleanup.md once you change it. It is also given your
	dictionary's words.
</TextFileEditor>
