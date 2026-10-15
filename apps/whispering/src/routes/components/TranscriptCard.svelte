<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { TRANSCRIPTIONS } from '$lib/definition.js';
	import type { Library, TranscriptionEntry } from '$lib/library.svelte.js';
	import { transformationName } from '$lib/post-processing.js';
	import { confirmDelete, copyText, formatTime, lf, openItem } from './file-actions.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import ResultStatus from './ResultStatus.svelte';
	import { onDestroy } from 'svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	/**
	 * One transcript of the recording that is open, edited where it is read,
	 * beside the player. Its text is the body of the transcript's own file,
	 * edited from the version it started at and saved a second after the last
	 * keystroke, when the person leaves it, and when the card goes away.
	 * A transcript whose answer has not reached its file says why instead, and
	 * is not edited while its answer is on its way. Nothing here selects the
	 * transcript's file, so the recording stays open.
	 */
	let { library, result }: { library: Library; result: TranscriptionEntry } = $props();
	// The list keys each card by its file; what is typed is sent to that one.
	// svelte-ignore state_referenced_locally
	const own = result.path;
	// The library's timer outlives the card; send what is typed now instead.
	onDestroy(() => void library.saveBody(own));

	/** Edited here unless the person opened its file as text in Files. */
	const asText = $derived(library.showsText(result.path));
	const row = $derived(asText ? undefined : library.rowAt(TRANSCRIPTIONS, result.path));
	/** The text now: as typed while an edit is unsaved, else as the file holds it. */
	const text = $derived(row?.body ?? result.row.body);
	const locked = $derived(library.locked(result.path));
	const progress = $derived(library.resultState(result.path, text));

	const outputs = $derived(library.outputsFor(result.stem));
	const transforming = $derived(library.recipeRuns.some((item) => item.transcriptionId === result.stem));
	/**
	 * Every transformation, with whether it can run now by the one decision
	 * the run itself makes. One that cannot is shown with why, and fixed on its
	 * own page or in Settings first.
	 */
	const choices = $derived(library.transformations.map((item) => ({ item, resolved: library.resolve(item.row) })));

	/** Apply a transformation to this transcript. The result is a new file; the transcript is not changed by it. */
	async function transform(path: string) {
		const problem = await library.transform(result.path, path);
		if (problem) toast.error('The transformation did not run', { description: problem });
	}
</script>

<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
	{#if progress.kind !== 'answered'}
		<ResultStatus {library} path={result.path} result={progress} onDelete={() => void confirmDelete(library, result.path)} />
	{/if}
	{#if progress.kind === 'running' || progress.kind === 'writing'}
		<!-- The answer is on its way into this file. A file with text is not filled, so typing now would keep it out. -->
	{:else if row}
		<Textarea
			class="min-h-32 resize-y font-sans"
			bind:value={
				() => lf(row?.body ?? ''),
				(value) =>
					library.editBody(TRANSCRIPTIONS, result.stem, withFileNewlines(wellFormed(value), row?.body ?? ''))
			}
			onblur={() => void library.saveBody(result.path)}
			disabled={locked}
			placeholder="This transcript has no text."
			aria-label="Transcript of {formatTime(result.row.fields.createdAt) || result.path}"
			data-testid="transcript-text"
		/>
		{#if library.isSaving(result.path)}
			<p class="text-xs text-muted-foreground" role="status">Saving…</p>
		{/if}
	{:else}
		<p class="max-h-64 overflow-y-auto rounded border p-2 whitespace-pre-wrap" data-testid="transcript-text-readonly">{text}</p>
	{/if}
	{#if asText}
		<p class="text-xs text-muted-foreground" role="status">
			This transcript’s file is open as text in Files, so its text is edited there.
		</p>
	{/if}
	<footer class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(result.row.fields.createdAt) || 'Unknown time'} · {result.row.fields.model}</span>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="outline" disabled={!text?.trim()} onclick={() => void copyText(text ?? '', 'the transcript')} data-testid="copy-transcript">
				Copy
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} size="xs" variant="outline" disabled={!text?.trim()} data-testid="transform">
							{#if transforming}<Spinner class="size-3" />{:else}<WandSparklesIcon />{/if}
							Transform
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="min-w-52">
					<DropdownMenu.Label>Make a new text from this transcript</DropdownMenu.Label>
					{#each choices as { item, resolved } (item.path)}
						<DropdownMenu.Item
							disabled={resolved.kind !== 'ready'}
							title={resolved.kind === 'blocked' ? resolved.reason : undefined}
							onSelect={() => void transform(item.path)}
						>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{transformationName(item)}</span>
								{#if resolved.kind === 'blocked'}
									<span class="text-xs text-muted-foreground">{resolved.fix === 'recipe' ? 'Needs repair' : 'Text connection not set up'}</span>
								{/if}
							</span>
						</DropdownMenu.Item>
					{:else}
						<DropdownMenu.Item disabled>No transformations yet</DropdownMenu.Item>
					{/each}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => void goto(resolve('/transformations'))}>
						Manage transformations…
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</span>
	</footer>
	{#each outputs as output (output.path)}
		<TransformationOutput
			{library}
			output={{ source: 'transcript', entry: output }}
			naming="transformation"
			onOpenFile={(path) => void openItem(library, path)}
		/>
	{/each}
</article>
