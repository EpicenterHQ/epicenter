<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { goto } from '$app/navigation';
	import { pathOf } from './nav-items.js';
	import { getLibrary, type TranscriptionNote } from '$lib/library.svelte.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import { transformationName } from '$lib/post-processing.js';
	import { confirmDelete, copyText, formatTime } from './file-actions.js';
	import { Textarea } from '@epicenter/ui/textarea';
	import RunStatus from './RunStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	/**
	 * One transcript of the recording that is open, edited where it is read,
	 * beside the player. Its text is the body of the transcript's own note,
	 * saved as it is typed.
	 */
	let { result }: { result: TranscriptionNote } = $props();
	const whispering = getWhispering();
	const library = getLibrary();
	// The list keys each card by its note; what is typed is sent to that one.
	// svelte-ignore state_referenced_locally
	const id = result.id;

	/** The text now: as typed until its save answers, else as the note holds it. */
	const body = fieldEdit(library.files.transcriptions, { id }, 'body');
	const text = $derived(body.value ?? result.body);

	const outputs = $derived(library.outputsFor(id));
	const runs = $derived(library.runsOn(id));
	const transforming = $derived(runs.some((run) => run.state.kind === 'running'));
	/**
	 * Every transformation, with whether it can run now by the one decision
	 * the run itself makes. One that cannot is shown with why, and fixed on its
	 * own page or in Settings first.
	 */
	const choices = $derived(library.transformations.map((item) => ({ item, resolved: whispering.resolve(item) })));

	/**
	 * Apply a transformation to this transcript as it is shown. The result is
	 * a new note; the transcript is not changed by it.
	 */
	async function transform(recipeId: string) {
		const problem = await library.transform(id, recipeId, { input: text });
		if (problem) toast.error('The transformation did not run', { description: problem });
	}
</script>

<article class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="transcription-result">
	<Textarea
		class="min-h-32 resize-y font-sans"
		bind:value={() => text, (value) => (body.value = value)}
		placeholder="This transcript has no text."
		aria-label="Transcript of {formatTime(result.createdAt) || result.id}"
		data-testid="transcript-text"
	/>
	<UnsavedEdit edit={body} />
	<footer class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(result.createdAt) || 'Unknown time'} · {result.model}</span>
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
					{#each choices as { item, resolved } (item.id)}
						<DropdownMenu.Item
							disabled={resolved.kind !== 'ready'}
							title={resolved.kind === 'blocked' ? resolved.reason : undefined}
							onSelect={() => void transform(item.id)}
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
					<DropdownMenu.Item onSelect={() => void goto(pathOf('transformations'))}>
						Manage transformations…
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button
				size="xs"
				variant="ghost-destructive"
				onclick={() => confirmDelete(library, { collection: 'transcriptions', id })}
				data-testid="delete-transcript"
			>
				Delete
			</Button>
		</span>
	</footer>
	{#each runs as run (run.key)}
		{#if run.state.kind !== 'running'}<RunStatus {run} />{/if}
	{/each}
	{#each outputs as output (output.id)}
		<TransformationOutput output={{ source: 'transcript', note: output }} naming="transformation" />
	{/each}
</article>
