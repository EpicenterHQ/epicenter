<!--
	The models that transcribe on this computer. One is in use; a model not
	yet downloaded offers its download, and downloading one puts it in use.
	The files live in the Hugging Face cache other apps share, which the
	line under the heading says, since Remove takes a model from them too.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import { DEFAULTS } from '#lib/data/settings.ts';
	import { modelDownloads } from '#lib/model-downloads.svelte.ts';
	import { local } from '#lib/platform/index.ts';
	import {
		modelsMutations,
		modelsQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';
	import SettingsSection from '../SettingsSection.svelte';

	const models = createQuery(() => modelsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	const inUse = $derived(settings.data?.['transcription.local.model']);

	/** The recommended model first, then the rest as the catalog orders them. */
	const listed = $derived(
		[...(models.data ?? [])].sort(
			(a, b) =>
				Number(b.id === DEFAULTS['transcription.local.model']) -
				Number(a.id === DEFAULTS['transcription.local.model']),
		),
	);

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

<SettingsSection
	title="Model"
	description="Models are kept in the Hugging Face cache on this computer, which other apps share. Removing one removes it for them too."
>
	{#if models.error}
		<p class="px-4 py-3.5 text-sm text-destructive" role="alert">{models.error.message}</p>
	{/if}
	{#each listed as model (model.id)}
		{@const share = modelDownloads.share(model.id)}
		<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5">
			<div class="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
				<p class="flex items-center gap-2 text-sm font-medium">
					{model.name}
					{#if model.downloaded && model.id === inUse}
						<Badge variant="secondary">In use</Badge>
					{:else if model.id === DEFAULTS['transcription.local.model']}
						<Badge variant="outline">Recommended</Badge>
					{/if}
				</p>
				<p class="text-sm text-muted-foreground">
					{model.description} · {megabytes(model.sizeBytes)}{model.supportsPrompt
						? ''
						: ' · Takes no dictionary hints'}
				</p>
				{#if share !== undefined}
					<Progress value={share * 100} class="mt-2" aria-label="Downloading {model.name}" />
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-1">
				{#if share !== undefined}
					<span class="text-sm text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span>
				{:else if !model.downloaded}
					<Button size="sm" variant="outline" onclick={() => download(model.id)}>
						Download · {megabytes(model.sizeBytes)}
					</Button>
				{:else}
					{#if model.id !== inUse}
						<Button size="sm" variant="outline" onclick={() => use(model.id)}>Use</Button>
					{/if}
					<Button size="sm" variant="ghost" onclick={() => local.reveal(model.id)}>Show</Button>
					<Button size="sm" variant="ghost" onclick={() => remove(model.id)}>Remove</Button>
				{/if}
			</div>
		</div>
	{/each}
</SettingsSection>
