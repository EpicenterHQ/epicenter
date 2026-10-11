<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { TRANSCRIPTIONS } from '$lib/definition.js';
	import type { Library, TranscriptionEntry } from '$lib/library.svelte.js';
	import { transformationName } from '$lib/post-processing.js';
	import { copyText, formatTime, lf, openItem } from './file-actions.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import SaveBar from '@epicenter/svelte/save-bar';
	import TransformationOutput from './TransformationOutput.svelte';

	/**
	 * One saved transcript of the recording that is open, edited where it is
	 * read, beside the player. Its text is the body of the transcript's own
	 * file, in a draft opened beside the recording and left with it. Nothing
	 * here selects the transcript's file, so the recording stays open.
	 */
	let { library, result }: { library: Library; result: TranscriptionEntry } = $props();

	// Open the file's draft once for this path, beside the recording.
	$effect(() => {
		const path = result.path;
		untrack(() => void library.openTranscript(path));
	});
	const draft = $derived(library.draftAt(result.path));
	const row = $derived(draft?.kind === 'row' && draft.table === TRANSCRIPTIONS ? draft.session : undefined);
	/** The text now: the draft's, or the row as listed. */
	const text = $derived(row?.draft.body ?? result.row.body);

	const outputs = $derived(library.outputsFor(result.stem));
	const transforming = $derived(
		library.transformationRuns.some(
			(item) => item.fields.transcriptionId === result.stem && item.state.kind === 'running',
		),
	);
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
	{#if row}
		<Textarea
			class="min-h-32 resize-y font-sans"
			bind:value={
				() => lf(row?.draft.body ?? ''),
				(value) =>
					row?.edit((draft) => {
						draft.body = withFileNewlines(wellFormed(value), draft.body);
					})
			}
			disabled={row.locked}
			placeholder="This transcript has no text."
			aria-label="Transcript of {formatTime(result.row.fields.createdAt) || result.path}"
			data-testid="transcript-text"
		/>
		<SaveBar
			save={row.state}
			review={row.review}
			hideWhenSaved
			onRetry={() => row.retry()}
			onResolve={(choices) => library.resolveReview(row, choices)}
		/>
	{:else}
		<p class="max-h-64 overflow-y-auto rounded border p-2 whitespace-pre-wrap" data-testid="transcript-text-readonly">{text}</p>
	{/if}
	{#if draft?.kind === 'text'}
		<p class="text-xs text-destructive" role="alert">
			This transcript’s file is being edited as text, so its text cannot be edited here. Open it from Files.
		</p>
		<SaveBar
			save={draft.session.state}
			review={draft.session.review}
			hideWhenSaved
			onRetry={() => draft.session.retry()}
			onResolve={(choices) => library.resolveReview(draft.session, choices)}
		/>
	{:else if draft?.kind === 'failed'}
		<p class="text-xs text-destructive" role="alert">
			This transcript’s file could not be opened: {draft.message}
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
