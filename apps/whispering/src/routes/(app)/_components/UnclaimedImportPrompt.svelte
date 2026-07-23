<!--
	Explicit import from this origin's unclaimed replica into the signed-in
	account (ADR-0178). Mounts once per signed-in session, previews Whispering's
	importable content through its Lens, and only acts on explicit confirmation.
	The same operation verifies the copy and retires the unclaimed replica;
	account settings never move.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { log } from '$lib/report';
	import type {
		UnclaimedImportCounts,
		WhisperingUnclaimedImport,
	} from '$lib/whispering/import-unclaimed';

	let { capability }: { capability: WhisperingUnclaimedImport } = $props();

	type ImportState =
		| { kind: 'offering' }
		| { kind: 'importing' }
		| { kind: 'imported'; counts: UnclaimedImportCounts }
		| { kind: 'import-failed'; message: string }
		| {
				kind: 'retirement-failed';
				counts: UnclaimedImportCounts;
				message: string;
		  };

	let isOpen = $state(true);
	let operation = $state.raw<ImportState>({ kind: 'offering' });

	const preview = $derived(
		capability.preview().catch((cause: unknown) => {
			log.warn(
				cause instanceof Error ? cause : new Error(String(cause)),
				'Unclaimed import preview failed',
			);
			return null;
		}),
	);

	async function runImport() {
		operation = { kind: 'importing' };
		try {
			const outcome = await capability.importAndRetire();
			if (outcome.kind === 'retired') {
				operation = { kind: 'imported', counts: outcome.counts };
				return;
			}
			if (outcome.cause !== undefined) {
				log.warn(
					outcome.cause instanceof Error
						? outcome.cause
						: new Error(String(outcome.cause)),
					'Unclaimed replica retirement failed',
				);
			}
			operation = {
				kind: 'retirement-failed',
				counts: outcome.counts,
				message:
					outcome.reason === 'held'
						? 'Another tab is still using the local data. Close other Whispering tabs and try again.'
						: 'Removing the local copy failed; nothing was deleted.',
			};
		} catch (cause) {
			operation = {
				kind: 'import-failed',
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}
</script>

{#await preview}
	<!-- No dialog until the unclaimed replica has been inspected. -->
{:then counts}
	{#if counts !== null}
		<Dialog.Root bind:open={isOpen}>
			<Dialog.Content>
				{#if operation.kind === 'imported'}
					<Dialog.Header>
						<Dialog.Title>Import complete</Dialog.Title>
						<Dialog.Description>
							Imported {operation.counts.recordings} recordings, {operation.counts
								.recipes} recipes into your account and removed the local copy.
							Your account settings did not change.
						</Dialog.Description>
					</Dialog.Header>
					<Dialog.Footer>
						<Button onclick={() => (isOpen = false)}>Done</Button>
					</Dialog.Footer>
				{:else if operation.kind === 'import-failed'}
					<Dialog.Header>
						<Dialog.Title>Import did not finish</Dialog.Title>
						<Dialog.Description>
							{operation.message} The local copy was kept, so you can safely try
							again.
						</Dialog.Description>
					</Dialog.Header>
					<Dialog.Footer>
						<Button variant="outline" onclick={() => (isOpen = false)}>
							Close
						</Button>
					</Dialog.Footer>
				{:else if operation.kind === 'retirement-failed'}
					<Dialog.Header>
						<Dialog.Title>Local copy was not removed</Dialog.Title>
						<Dialog.Description>
							Imported {operation.counts.recordings} recordings and {operation
								.counts.recipes} recipes. Your account settings did not change.
							{operation.message}
						</Dialog.Description>
					</Dialog.Header>
					<Dialog.Footer>
						<Button variant="outline" onclick={() => (isOpen = false)}>
							Keep local copy
						</Button>
						<Button onclick={runImport}>Try again</Button>
					</Dialog.Footer>
				{:else}
					<Dialog.Header>
						<Dialog.Title>Import local data into your account?</Dialog.Title>
						<Dialog.Description>
							This browser has {counts.recordings} recordings and {counts.recipes}
							recipes created before you signed in. Import them into your account
							and remove the local copy? Your account settings will not change.
						</Dialog.Description>
					</Dialog.Header>
					<Dialog.Footer>
						<Button
							variant="outline"
							disabled={operation.kind === 'importing'}
							onclick={() => (isOpen = false)}
						>
							Not now
						</Button>
						<Button
							disabled={operation.kind === 'importing'}
							onclick={runImport}
						>
							{operation.kind === 'importing'
								? 'Importing...'
								: 'Import and remove local copy'}
						</Button>
					</Dialog.Footer>
				{/if}
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/await}
