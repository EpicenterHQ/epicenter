<script lang="ts">
	/**
	 * Connect: choose the remote the todos sync with. The choice is a URL the
	 * folder keeps in its own Git configuration; connecting then syncs once.
	 * An empty folder takes the remote's todos, a folder with todos sends
	 * them, and a remote with its own separate history asks before both are
	 * combined. Conflicts open the same review as Sync.
	 */
	import type { SyncError, SyncOutcome } from '@epicenter/folder';
	import { Alert, AlertDescription, AlertTitle } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import { toastStatus } from '@epicenter/svelte/status-popover';
	import type { CreateMutationResult } from '@tanstack/svelte-query';
	import { Err, Ok } from 'wellcrafted/result';
	import type { ActionError } from '@epicenter/svelte/write-failure';
	import { remoteLabel, syncOutcomeLine } from '$lib/status.js';
	import { isEpicenter } from '$lib/remote.js';
	import type { ConnectTo } from '$lib/sync.js';
	import { getTodos } from '$lib/todos.svelte.js';
	import SyncChoices from './SyncChoices.svelte';

	let {
		open = $bindable(false),
		sync,
	}: {
		open?: boolean;
		/** The page's Sync, which connects when given a URL. */
		sync: CreateMutationResult<SyncOutcome, SyncError | ActionError, ConnectTo | void, unknown>;
	} = $props();

	const todos = getTodos();
	const current = $derived(todos.git.snapshot.remote);
	/** A remote whose history is separate from this folder's, waiting for the person's answer. */
	let unrelated = $state<string>();

	function connectTo(target: ConnectTo) {
		sync.mutate(target, {
			onSettled: (outcome, error) => {
				if (error?.name === 'Unrelated') {
					unrelated = target.url;
					return;
				}
				unrelated = undefined;
				open = false;
				toastStatus(syncOutcomeLine(error ? Err(error) : Ok(outcome!), todos.git.snapshot));
			},
		});
	}
</script>

<Dialog.Root
	bind:open={() => open, (next) => {
		if (sync.isPending) return;
		open = next;
		if (!next) unrelated = undefined;
	}}
>
	<Dialog.Content class="max-w-lg" data-testid="connect">
		<Dialog.Header>
			<Dialog.Title>{current === undefined ? 'Connect' : 'Change remote'}</Dialog.Title>
			<Dialog.Description>
				{current === undefined
					? 'Choose where your todos sync. They stay Markdown files, here and there.'
					: `Your todos sync with ${remoteLabel(current.url, isEpicenter)}. Choose another remote to sync with it instead.`}
			</Dialog.Description>
		</Dialog.Header>
		{#if unrelated !== undefined}
			<Alert variant="warning" data-testid="connect-unrelated">
				<AlertTitle>{remoteLabel(unrelated, isEpicenter)} already has todos of its own</AlertTitle>
				<AlertDescription>
					Its history and this folder's are separate. Combining keeps both; where the same todo differs, you choose.
					Nothing has changed yet.
				</AlertDescription>
			</Alert>
			<Dialog.Footer>
				<Button variant="outline" disabled={sync.isPending} onclick={() => (unrelated = undefined)}>Choose another</Button>
				<Button
					disabled={sync.isPending}
					data-testid="connect-combine"
					onclick={() => unrelated !== undefined && connectTo({ url: unrelated, combine: true })}
				>
					{#if sync.isPending}<Spinner class="size-3.5" />{/if}
					Combine them
				</Button>
			</Dialog.Footer>
		{:else}
			<SyncChoices busy={sync.isPending} onchoose={(url) => connectTo({ url })} />
			{#if sync.isPending}
				<p class="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner class="size-3.5" /> Connecting and syncing…
				</p>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
