<!--
	The models that transcribe on this computer. One is in use; a model not
	yet downloaded offers its download, and downloading one puts it in use.
	The files live in the Hugging Face cache other apps share, which the
	note under the list says, since Remove takes a model from them too.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import { modelDownloads } from '#lib/model-downloads.svelte.ts';
	import { local } from '#lib/platform/index.ts';
	import {
		modelsMutations,
		modelsQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';

	const models = createQuery(() => modelsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	const inUse = $derived(settings.data?.['transcription.local.model']);

	const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

	async function use(id: string) {
		const saved = await runMutation(queryClient, settingsMutations.update, {
			'transcription.local.model': id,
		});
		toastOnError(saved, 'Could not choose the model');
	}

	async function download(id: string) {
		const downloaded = await modelDownloads.start(id);
		if (downloaded.error) return toastOnError(downloaded, 'Could not download the model');
		await use(id);
	}

	async function remove(id: string) {
		const removed = await runMutation(queryClient, modelsMutations.remove, { id });
		toastOnError(removed, 'Could not remove the model');
	}
</script>

<Field.Set>
	<Field.Legend>Model</Field.Legend>
	{#if models.error}
		<Field.Error>{models.error.message}</Field.Error>
	{/if}
	<Item.Group class="gap-2">
		{#each models.data ?? [] as model (model.id)}
			{@const share = modelDownloads.share(model.id)}
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Title>
						{model.name}
						{#if model.downloaded && model.id === inUse}<Badge variant="secondary">In use</Badge>{/if}
					</Item.Title>
					<Item.Description>
						{model.description} · {megabytes(model.sizeBytes)}{model.supportsPrompt
							? ''
							: ' · Does not take dictionary words as hints'}
					</Item.Description>
					{#if share !== undefined}
						<Progress value={share * 100} class="mt-2" aria-label="Downloading {model.name}" />
					{/if}
				</Item.Content>
				<Item.Actions>
					{#if share !== undefined}
						<span class="text-sm text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span>
					{:else if !model.downloaded}
						<Button size="sm" onclick={() => download(model.id)}>Download</Button>
					{:else}
						{#if model.id !== inUse}
							<Button size="sm" variant="outline" onclick={() => use(model.id)}>Use</Button>
						{/if}
						<Button size="sm" variant="ghost" onclick={() => local.reveal(model.id)}>Show</Button>
						<Button size="sm" variant="ghost" onclick={() => remove(model.id)}>Remove</Button>
					{/if}
				</Item.Actions>
			</Item.Root>
		{/each}
	</Item.Group>
	<Field.Description>
		Models are kept in the Hugging Face cache on this computer, which other apps share. Removing
		one removes it for them too.
	</Field.Description>
</Field.Set>
