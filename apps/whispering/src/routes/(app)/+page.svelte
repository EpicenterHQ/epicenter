<!--
	Home: how much has been dictated, once there is any; the recorder, or
	the first-run panel while the chosen model is not downloaded; anything
	dictation still needs; and what you said last, to read and copy again, with the two takes before it. Finding an
	older one is Recordings' job.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { createQuery } from '@tanstack/svelte-query';
	import { transcriber } from '#lib/data/settings.ts';
	import { getDictation } from '#lib/dictation-view.ts';
	import { formatDuration, usage } from '#lib/feed.ts';
	import { modelDownloads } from '#lib/model-downloads.svelte.ts';
	import { modelsQueries, recordingsQueries, settingsQueries } from '#lib/queries.ts';
	import AddSampleButton from './AddSampleButton.svelte';
	import FirstRun from './FirstRun.svelte';
	import NeedsLine from './NeedsLine.svelte';
	import Page from './Page.svelte';
	import RecorderPanel from './RecorderPanel.svelte';
	import RecordingRow from './RecordingRow.svelte';

	const dictation = getDictation();
	const list = createQuery(() => recordingsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	/** Newest first; the list arrives oldest first. */
	const recent = $derived((list.data ?? []).slice(-3).reverse());
	const latest = $derived(recent[0]);
	const stats = $derived(usage(list.data ?? []));
	const chosen = $derived(settings.data && transcriber(settings.data));
	const models = createQuery(() => modelsQueries.list());
	/** What transcribes, as the line under the recorder names it. */
	const transcribedBy = $derived.by(() => {
		if (chosen?.kind === 'server') return `${chosen.model} at ${new URL(chosen.baseUrl).host}`;
		if (chosen?.kind !== 'local') return undefined;
		const model = models.data?.find((model) => model.id === chosen.model);
		return model ? `${model.name} on this computer` : undefined;
	});
	const unmet = $derived(dictation.needs().length > 0);

	/**
	 * The model to download first: the chosen one, while it is missing and
	 * nothing records. A take started by the shortcut still shows the recorder.
	 */
	const missing = $derived(
		chosen?.kind === 'local' &&
			dictation.take().kind === 'idle' &&
			dictation.needs().some((need) => need.id === 'model')
			? models.data?.find((model) => model.id === chosen.model)
			: undefined,
	);
	let downloadError = $state<string>();

	async function download(id: string) {
		downloadError = undefined;
		const { error } = await modelDownloads.start(id);
		downloadError = error?.message;
	}
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Page title="Whispering" description="Speak in any app, and the text is on your clipboard.">
	{#if stats.words > 0}
		<dl class="grid grid-cols-3 gap-3">
			{#each [
				{ label: stats.days === 1 ? 'day' : 'days', value: stats.days.toLocaleString() },
				{ label: stats.words === 1 ? 'word' : 'words', value: stats.words.toLocaleString() },
				{ label: 'words a minute', value: stats.wordsPerMinute?.toLocaleString() ?? '–' },
			] as stat (stat.label)}
				<div class="flex flex-col gap-0.5 rounded-xl bg-card px-4 py-3 shadow-xs ring-1 ring-foreground/10">
					<dd class="text-2xl font-semibold tabular-nums">{stat.value}</dd>
					<dt class="text-xs text-muted-foreground">{stat.label}</dt>
				</div>
			{/each}
		</dl>
	{/if}

	{#if missing}
		<FirstRun
			name={missing.name}
			sizeBytes={missing.sizeBytes}
			share={modelDownloads.share(missing.id)}
			error={downloadError}
			ondownload={() => download(missing.id)}
		/>
	{:else}
		<div class="flex flex-col gap-2">
			<RecorderPanel />
			{#if unmet}
				<NeedsLine />
			{:else if transcribedBy}
				<p class="px-1 text-xs text-muted-foreground">
					{transcribedBy} · Copies to the clipboard ·
					<a class="underline underline-offset-2 hover:text-foreground" href="/settings/transcription">Change</a>
				</p>
			{/if}
		</div>
	{/if}

	{#if latest}
		<section
			class="flex flex-col gap-2 rounded-xl bg-card py-3 text-card-foreground shadow-xs ring-1 ring-foreground/10"
			aria-labelledby="latest"
		>
			<div class="flex flex-wrap items-center gap-x-2 px-4">
				<h2 id="latest" class="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Latest
				</h2>
				{#if import.meta.env.DEV}<AddSampleButton />{/if}
				<Button variant="link" size="sm" href="/recordings">All recordings</Button>
			</div>

			{#if latest.transcript && !dictation.isTranscribing(latest.id)}
				<div class="flex flex-col gap-2 px-4">
					<p class="line-clamp-4 text-base leading-relaxed">{latest.transcript}</p>
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<a class="hover:text-foreground" href="/recordings?id={encodeURIComponent(latest.id)}">
							{latest.at?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
							{#if latest.durationMs !== undefined}· {formatDuration(latest.durationMs)}{/if}
						</a>
						<CopyButton text={latest.transcript} size="sm" variant="ghost" class="ml-auto">Copy</CopyButton>
					</div>
				</div>
			{:else}
				<RecordingRow recording={latest} />
			{/if}

			{#if recent.length > 1}
				<div class="flex flex-col border-t px-1 pt-2">
					{#each recent.slice(1) as recording (recording.id)}
						<RecordingRow {recording} copy />
					{/each}
				</div>
			{/if}
		</section>
	{:else if import.meta.env.DEV}
		<div class="flex justify-center"><AddSampleButton /></div>
	{/if}
</Page>
