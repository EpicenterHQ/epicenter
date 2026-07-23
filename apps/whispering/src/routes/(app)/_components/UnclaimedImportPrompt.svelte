<!--
	Explicit import from this origin's unclaimed replica into the signed-in
	account (ADR-0178). Mounts once per signed-in session, previews the
	unclaimed replica through the app's own Lens, and only ever acts on an
	explicit confirmation. Retirement is a second explicit step offered after
	the import verified its writes; declining keeps the local copy forever.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Label } from '@epicenter/ui/label';
	import { log } from '$lib/report';
	import type {
		UnclaimedImportCounts,
		WhisperingUnclaimedImport,
	} from '$lib/whispering/import-unclaimed';

	let { capability }: { capability: WhisperingUnclaimedImport } = $props();

	let isOpen = $state(false);
	let counts = $state<UnclaimedImportCounts | null>(null);
	let phase = $state<'offer' | 'importing' | 'imported' | 'failed'>('offer');
	let imported = $state<UnclaimedImportCounts | null>(null);
	let failure = $state('');
	let selectRecordings = $state(true);
	let selectRecipes = $state(true);
	let selectSettings = $state(true);

	$effect(() => {
		let cancelled = false;
		void capability.preview().then(
			(preview) => {
				if (cancelled || preview === null) return;
				counts = preview;
				selectRecordings = preview.recordings > 0;
				selectRecipes = preview.recipes > 0;
				selectSettings = preview.settings > 0;
				isOpen = true;
			},
			(cause: unknown) => {
				log.warn(
					cause instanceof Error ? cause : new Error(String(cause)),
					'Unclaimed import preview failed',
				);
			},
		);
		return () => {
			cancelled = true;
		};
	});

	const hasSelection = $derived(
		selectRecordings || selectRecipes || selectSettings,
	);

	async function runImport() {
		phase = 'importing';
		try {
			imported = await capability.importSelected({
				recordings: selectRecordings,
				recipes: selectRecipes,
				settings: selectSettings,
			});
			phase = 'imported';
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
			phase = 'failed';
		}
	}

	async function retire() {
		try {
			const outcome = await capability.retire();
			if (outcome === 'held') {
				failure =
					'Another tab is still using the local data. Close other Whispering tabs and try again.';
				phase = 'failed';
				return;
			}
		} catch (cause) {
			log.warn(
				cause instanceof Error ? cause : new Error(String(cause)),
				'Unclaimed replica retirement failed',
			);
			failure = 'Removing the local copy failed; nothing was deleted.';
			phase = 'failed';
			return;
		}
		isOpen = false;
	}
</script>

<Dialog.Root bind:open={isOpen}>
	<Dialog.Content>
		{#if phase === 'imported'}
			<Dialog.Header>
				<Dialog.Title>Import complete</Dialog.Title>
				<Dialog.Description>
					Imported {imported?.recordings ?? 0} recordings, {imported?.recipes ??
						0} recipes, and {imported?.settings ?? 0} settings into your
					account. You can remove the local copy now or keep it.
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (isOpen = false)}>
					Keep local copy
				</Button>
				<Button variant="destructive" onclick={retire}>
					Remove local copy
				</Button>
			</Dialog.Footer>
		{:else if phase === 'failed'}
			<Dialog.Header>
				<Dialog.Title>Import did not finish</Dialog.Title>
				<Dialog.Description>
					{failure} Your local data is untouched; you can try again from the
					next sign-in.
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (isOpen = false)}>Close</Button>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Import local data into your account?</Dialog.Title>
				<Dialog.Description>
					This browser has data created before you signed in. Choose what to
					copy into your account. Nothing is imported or deleted without your
					confirmation.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-3 py-2">
				{#if (counts?.recordings ?? 0) > 0}
					<Label class="flex items-center gap-2">
						<Checkbox
							bind:checked={selectRecordings}
							disabled={phase === 'importing'}
						/>
						{counts?.recordings} recordings
					</Label>
				{/if}
				{#if (counts?.recipes ?? 0) > 0}
					<Label class="flex items-center gap-2">
						<Checkbox
							bind:checked={selectRecipes}
							disabled={phase === 'importing'}
						/>
						{counts?.recipes} recipes
					</Label>
				{/if}
				{#if (counts?.settings ?? 0) > 0}
					<Label class="flex items-center gap-2">
						<Checkbox
							bind:checked={selectSettings}
							disabled={phase === 'importing'}
						/>
						{counts?.settings} settings
					</Label>
				{/if}
			</div>
			<Dialog.Footer>
				<Button
					variant="outline"
					disabled={phase === 'importing'}
					onclick={() => (isOpen = false)}
				>
					Not now
				</Button>
				<Button
					disabled={phase === 'importing' || !hasSelection}
					onclick={runImport}
				>
					{phase === 'importing' ? 'Importing...' : 'Import selected'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
