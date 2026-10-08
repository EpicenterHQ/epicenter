<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import { bootFailure } from '$lib/boot-failure.js';
	import type { EraseReplica } from '$lib/boot-failure.js';

	// The erase arrives as data rather than being imported, because it is only
	// callable in the state that hands it over: erasing takes the same claim an
	// open takes, so erasing an open store is refused by the store, and a failed
	// open released its claim before it returned (ADR-0340).
	//
	// So does the retry, and for the same reason it is a prop rather than
	// `location.reload()`: opening is a verb now, and a failed session opens
	// again from where it is. The route passes `epicenter.open`, so trying again
	// re-runs exactly the thing that failed instead of throwing the document
	// away to get back to a state the session can already reach.
	let {
		error = undefined,
		erase: eraseReplica = undefined,
		retry = undefined,
	}: { error?: unknown; erase?: EraseReplica; retry?: () => void } = $props();

	// One decision, made in `bootFailure`: the sentence and the control below it
	// are the same answer, so nothing here re-reads the error to pick a verb.
	const failure = $derived(error === undefined ? undefined : bootFailure(error));

	let confirmingErase = $state(false);
	let erasing = $state(false);
	/**
	 * What the erase itself failed with, which is not what brought a person
	 * here.
	 *
	 * Its own state rather than reassigning `error`, because `error` is the
	 * boot's and the gate keeps saying why they are looking at this screen. The
	 * usual value is another window holding the notes open, which
	 * `eraseGenerations` refuses whole rather than half-doing, so this line is
	 * the only place a person learns nothing was deleted.
	 */
	let eraseFailure = $state<string | undefined>(undefined);

	async function erase() {
		if (eraseReplica === undefined) return;
		erasing = true;
		eraseFailure = undefined;
		const { error } = await eraseReplica();
		erasing = false;
		if (error !== null) {
			eraseFailure = bootFailure(error).message;
			return;
		}
		// Opened rather than reloaded. The refusal that brought them here was
		// about a copy that no longer exists, and a session that failed opens
		// again: this resolves what the account has now and bootstraps it. The
		// reload this used to do was working around a memo that is gone.
		retry?.();
	}
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">Honeycrisp</h1>
			<p class="text-sm text-muted-foreground">
				{failure?.message ?? 'Sign in to open your notes.'}
			</p>
			{#if error !== undefined}
				<p class="text-xs text-muted-foreground/70">{extractErrorMessage(error)}</p>
			{/if}
		</div>

		{#if failure?.repair === 'retry'}
			<Button size="lg" onclick={() => retry?.()}>Try again</Button>
		{:else if failure?.repair === 'none'}
			<!-- Nothing to offer. A runtime with no Web Locks is not repaired by
			     trying again or by signing in as somebody else, and a button that
			     cannot help is worse than no button. -->
		{:else if failure?.repair === 'erase'}
			<div class="flex flex-col items-center gap-2">
				<!--
					Sign OUT, because they are signed in: as the account that cannot
					open these notes. The popover's signed-in branch offers exactly
					this, and labelling it "Sign in as that account" would name a
					button that is not there.
				-->
				<AccountPopover {auth} syncNoun="notes">
					{#snippet trigger({ props })}
						<Button {...props} size="lg">Switch account</Button>
					{/snippet}
				</AccountPopover>
				<Button
					variant="ghost"
					size="sm"
					disabled={erasing}
					onclick={() => (confirmingErase = true)}
				>
					Erase this device’s copy
				</Button>
				{#if eraseFailure !== undefined}
					<p class="text-xs text-destructive">{eraseFailure}</p>
				{/if}
			</div>
		{:else}
			<AccountPopover {auth} syncNoun="notes">
				{#snippet trigger({ props })}
					<Button {...props} size="lg">Sign in to continue</Button>
				{/snippet}
			</AccountPopover>
		{/if}
	</div>
</div>

<AlertDialog.Root bind:open={confirmingErase}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Erase this device’s copy?</AlertDialog.Title>
			<AlertDialog.Description>
				Every note on this device will be deleted. Whatever had already
				reached the account they belong to is still there; anything that had
				not is gone. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={erase}>Erase</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
