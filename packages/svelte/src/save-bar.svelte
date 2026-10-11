<!--
	One edit session's save state, and the conflict prompt.

	A change made elsewhere is merged by the session first. When parts
	compete, `review` shows only those parts in the shared review grid, and
	Cancel falls back to "Reload theirs" or "Keep mine". Otherwise a change
	made elsewhere that cannot be merged asks "Reload theirs" or "Keep mine". A file
	deleted elsewhere asks "Discard" or "Keep mine", which creates it again
	from the draft; without `onKeepMine` only Discard is offered. Any other
	failed save offers "Try again", and a save whose reply was lost "Save
	again". A draft that is not a valid row is never written; the bar names
	what to fix.
-->
<script lang="ts">
	import type { SaveState, SyncChoiceProblem } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { SaveReview } from './edit-session.svelte.js';
	import SyncReview from './sync-review.svelte';

	type Failure = {
		readonly name: string;
		readonly message: string;
		readonly actualSha256?: string;
		readonly issues?: readonly { readonly message: string }[];
	};

	let {
		save,
		review,
		onRetry,
		onReloadTheirs,
		onKeepMine,
		gone: goneOutside = false,
		hideWhenSaved = false,
		class: className = '',
	}: {
		save: SaveState<Failure>;
		/** The session's competing parts, while a merge waits for the person. */
		review?: SaveReview;
		onRetry: () => void;
		/** Answers what the person is told, if anything. */
		onReloadTheirs: () => Promise<string | undefined>;
		/** Omitted when the file cannot be restored; only Discard is offered then. */
		onKeepMine?: () => Promise<string | undefined>;
		/** The app knows the file is gone, though the conflict was over a change. */
		gone?: boolean;
		/** Show nothing while every save has landed. */
		hideWhenSaved?: boolean;
		class?: string;
	} = $props();

	let choosing = $state(false);
	let applying = $state(false);
	/** What the folder refused in the last Apply, for the review it answered. */
	let refused = $state.raw<{ id: string; problems: readonly SyncChoiceProblem[] }>();

	async function apply(choices: Parameters<SaveReview['apply']>[0]) {
		const answered = review;
		if (answered === undefined) return;
		applying = true;
		const { error } = await answered.apply(choices);
		applying = false;
		if (error === null) return;
		if (error.name === 'InvalidChoices' && 'problems' in error)
			refused = {
				id: answered.id,
				problems: error.problems as readonly SyncChoiceProblem[],
			};
		else toast.error('Could not save your choices', { description: error.message });
	}

	async function choose(run: () => Promise<string | undefined>) {
		choosing = true;
		const problem = await run();
		choosing = false;
		if (problem) toast.error('Could not resolve the conflict', { description: problem });
	}

	const error = $derived(save.status === 'error' ? save.error : undefined);
	const gone = $derived(
		error?.name === 'Conflict' && (goneOutside || error.actualSha256 === undefined),
	);
</script>

{#if !(hideWhenSaved && save.status === 'saved')}
	<div
		class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs {className}"
		data-testid="save-bar"
	>
		{#if review}
			<span class="text-destructive" role="alert">
				This changed elsewhere. Your edits are kept here and not saved.
			</span>
			<div class="w-full py-2">
				{#key review.id}
					<SyncReview
						attempt={review}
						pending={applying}
						problems={refused?.id === review.id ? refused.problems : []}
						labels={{ local: 'Your edit', incoming: 'Saved elsewhere' }}
						description="Changes that do not overlap were combined. Choose what to keep for these parts, or cancel to keep yours or reload theirs."
						applyLabel="Apply"
						onCancel={() => review?.cancel()}
						onApply={(_, choices) => void apply(choices)}
					/>
				{/key}
			</div>
		{:else if error?.name === 'Conflict'}
			<span class="text-destructive" role="alert">
				{gone
					? 'This was deleted elsewhere. Your edits are kept here and not saved.'
					: 'This changed elsewhere. Your edits are kept here and not saved.'}
			</span>
			<Button size="xs" variant="outline" disabled={choosing} onclick={() => void choose(onReloadTheirs)}>
				{gone ? 'Discard' : 'Reload theirs'}
			</Button>
			{#if onKeepMine}
				<Button size="xs" disabled={choosing} onclick={() => void choose(onKeepMine)}>Keep mine</Button>
			{/if}
		{:else if error?.name === 'InvalidValues'}
			<span class="text-destructive" role="alert">
				Not saved: {error.issues?.map((issue) => issue.message).join(' ') ?? error.message}
			</span>
		{:else if error?.name === 'Unconfirmed'}
			<span class="text-destructive" role="alert">
				The save was sent, but nothing confirmed it, so it may or may not be in the file.
			</span>
			<Button size="xs" onclick={onRetry}>Save again</Button>
		{:else if error}
			<span class="text-destructive" role="alert">Not saved: {error.message}</span>
			<Button size="xs" onclick={onRetry}>Try again</Button>
		{:else if save.status === 'saving'}
			<span class="text-muted-foreground">Saving…</span>
		{:else}
			<span class="text-muted-foreground">Saved to <code class="font-mono">{save.file.path}</code></span>
		{/if}
	</div>
{/if}
