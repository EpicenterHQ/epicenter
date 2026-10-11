<!--
	One edit session's save state, and its review.

	A change made elsewhere is merged by the folder first. What it cannot
	decide, `review`, shows in the shared review grid: only the parts both
	changed, or the whole file when it was deleted elsewhere or is no longer
	this kind. Apply answers every part at once through `onResolve`; there is
	no Cancel, because the draft is waiting to be saved. What the folder
	refuses shows beside its part. Any other failed save offers "Try again",
	and a save whose reply was lost "Save again". A draft that is not a valid
	row is never written; the bar names what to fix.
-->
<script lang="ts">
	import type { SaveState, SyncChoices } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { SaveReview } from './edit-session.svelte.js';
	import SyncReview from './sync-review.svelte';

	type Failure = {
		readonly name: string;
		readonly message: string;
		readonly issues?: readonly { readonly message: string }[];
	};

	let {
		save,
		review,
		onRetry,
		onResolve,
		hideWhenSaved = false,
		class: className = '',
	}: {
		save: SaveState<Failure>;
		/** What the session's merge left for the person to choose. */
		review: SaveReview | undefined;
		onRetry: () => void;
		/** Answer every part of `review`; answers what the person is told, if anything. */
		onResolve: (choices: SyncChoices) => Promise<string | undefined>;
		/** Show nothing while every save has landed. */
		hideWhenSaved?: boolean;
		class?: string;
	} = $props();

	let applying = $state(false);

	async function apply(choices: SyncChoices) {
		applying = true;
		const problem = await onResolve(choices);
		applying = false;
		// A refused part already shows its reason beside it.
		if (problem && !review?.problems.length)
			toast.error('Could not save your choices', { description: problem });
	}

	const error = $derived(save.status === 'error' ? save.error : undefined);
	/** The review is over the whole file, which is gone elsewhere. */
	const deleted = $derived(
		review?.conflicts.some(
			(conflict) => conflict.kind === 'file' && !conflict.incoming.present,
		) ?? false,
	);
</script>

{#if !(hideWhenSaved && save.status === 'saved')}
	<div
		class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs {className}"
		data-testid="save-bar"
	>
		{#if review}
			<span class="text-destructive" role="alert">
				{deleted ? 'This was deleted elsewhere.' : 'This changed elsewhere.'}
				Your edits are kept here and not saved.
			</span>
			<div class="w-full py-2">
				{#key review.id}
					<SyncReview
						attempt={review}
						pending={applying}
						problems={review.problems}
						labels={{ local: 'Your edit', incoming: 'Saved elsewhere' }}
						description={deleted
							? 'Use your edit to keep the file, or use theirs to leave it deleted.'
							: 'Changes that do not overlap were combined. Choose what to keep for these parts.'}
						applyLabel="Apply"
						onApply={(_, choices) => void apply(choices)}
					/>
				{/key}
			</div>
		{:else if error?.name === 'Conflict'}
			<span class="text-destructive" role="alert">
				This changed elsewhere and could not be combined: your edits are kept here and not saved.
			</span>
			<Button size="xs" onclick={onRetry}>Try again</Button>
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
