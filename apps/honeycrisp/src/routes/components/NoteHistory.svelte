<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import type { FileRevision, NotesHost } from '$lib/platform/types.js';

	let {
		history,
		path,
		admitting,
		onUse,
		open = $bindable(),
	}: {
		history: NonNullable<NotesHost['history']>;
		path: string;
		/** Whether input is being taken; false while the app answers a close. */
		admitting: boolean;
		/** Put this version in the note, which writes it. Answers why it was not taken, or undefined. */
		onUse: (source: string) => string | undefined;
		open: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	const revisions = history.log(path, 50);
	let shown = $state<{ revision: FileRevision; source: string } | undefined>();

	async function show(revision: FileRevision) {
		try {
			shown = { revision, source: await history.show(revision.oid, path) };
		} catch (cause) {
			toast.error('Could not read that version', {
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>Saved versions of {path}</Dialog.Title>
			<Dialog.Description>
				A version is saved when you choose Save version, or by a commit made in the terminal. Using one
				replaces the note's text and saves it at once.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid min-h-0 flex-1 grid-cols-[14rem_1fr] gap-3">
			<ul class="min-h-0 space-y-0.5 overflow-y-auto text-xs" aria-label="Versions">
				{#await revisions}
					<li class="text-muted-foreground">Reading history…</li>
				{:then list}
					{#each list as revision (revision.oid)}
						<li>
							<Button
								class="h-auto w-full flex-col items-start gap-0 py-1 text-left"
								size="sm"
								variant={shown?.revision.oid === revision.oid ? 'secondary' : 'ghost'}
								onclick={() => void show(revision)}
							>
								<span class="font-mono">{revision.oid.slice(0, 7)}</span>
								<span class="w-full truncate text-muted-foreground">{revision.subject}</span>
								<span class="text-muted-foreground">{new Date(revision.timestamp * 1000).toLocaleString()}</span>
							</Button>
						</li>
					{:else}
						<li class="text-muted-foreground">No saved version includes this file yet. Save version records one.</li>
					{/each}
				{:catch error}
					<li class="text-destructive">{error instanceof Error ? error.message : String(error)}</li>
				{/await}
			</ul>
			<pre class="min-h-40 overflow-auto rounded border bg-muted/30 p-2 font-mono text-xs">{shown?.source ?? 'Choose a version to read it.'}</pre>
		</div>
		<Dialog.Footer>
			<Button
				disabled={shown === undefined || !admitting}
				onclick={() => {
					if (shown === undefined) return;
					// A version that is not taken stays chosen.
					const problem = onUse(shown.source);
					if (problem === undefined) open = false;
					else toast.error('Could not use this version', { description: problem });
				}}
			>
				Use this version
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
