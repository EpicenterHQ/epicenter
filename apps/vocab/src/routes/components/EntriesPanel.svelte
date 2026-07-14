<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { Entry, EntryId } from '@epicenter/vocab';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { entriesState } from '$lib/state/entries.svelte';

	let {
		onPractice,
		generating,
	}: {
		onPractice: (entryTexts: string[]) => void;
		/** A turn is in flight in the active conversation, so a compiled practice
		 * turn would be dropped by the loop's guard. Disable the trigger instead. */
		generating: boolean;
	} = $props();

	/** The one-way cycle a stage button steps through on each click. */
	const NEXT_STAGE: Record<Entry['stage'], Entry['stage']> = {
		new: 'understood',
		understood: 'usable',
		usable: 'new',
	};

	/** Stage filter values: `all` plus the three acquisition stages. Drives both
	 * the visible list and the set "Practice these" compiles. Focus is a filter
	 * over the flat pool, never a stored partition. */
	const STAGE_FILTERS = ['all', 'new', 'understood', 'usable'] as const;
	type StageFilter = (typeof STAGE_FILTERS)[number];
	let stageFilter = $state<StageFilter>('all');

	const filteredEntries = $derived(
		stageFilter === 'all'
			? entriesState.entries
			: entriesState.entries.filter((entry) => entry.stage === stageFilter),
	);

	/** Cap the compiled set so a large pool cannot build a runaway prompt. Newest
	 * first, since `entriesState.entries` already sorts that way. */
	const PRACTICE_CAP = 20;
	const practiceEntries = $derived(filteredEntries.slice(0, PRACTICE_CAP));

	let newEntry = $state('');

	async function addEntry() {
		if (await entriesState.save(newEntry)) {
			newEntry = '';
		}
	}

	function cycleStage(id: EntryId, stage: Entry['stage']) {
		entriesState.setStage(id, NEXT_STAGE[stage]);
	}

	function commitNote(entry: Entry, note: string) {
		if (note !== entry.note) entriesState.setNote(entry.id, note);
	}
</script>

<Sidebar.Group class="group-data-[collapsible=icon]:hidden">
	<Sidebar.GroupLabel>
		<span>Entries</span>
		<span class="ml-auto text-xs text-muted-foreground">
			usable: {entriesState.usableCount}
		</span>
	</Sidebar.GroupLabel>
	<Sidebar.GroupContent>
		<form
			class="flex items-center gap-1 px-2 py-1"
			onsubmit={(event) => {
				event.preventDefault();
				void addEntry().catch(reportError);
			}}
		>
			<Input bind:value={newEntry} placeholder="Entry" class="h-7 text-sm" />
			<Button type="submit" size="icon-sm" variant="outline" aria-label="Add entry">
				<PlusIcon class="size-3.5" />
			</Button>
		</form>

		<div class="flex flex-wrap gap-1 px-2 py-1">
			{#each STAGE_FILTERS as filter (filter)}
				<button
					type="button"
					class="rounded-sm border px-1.5 py-0.5 text-[10px] uppercase {stageFilter ===
					filter
						? 'bg-accent text-accent-foreground'
						: 'text-muted-foreground'}"
					aria-pressed={stageFilter === filter}
					onclick={() => (stageFilter = filter)}
				>
					{filter}
				</button>
			{/each}
		</div>

		<div class="px-2 py-1">
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="w-full"
				disabled={generating || practiceEntries.length === 0}
				title={generating
					? 'Finish the current turn to practice'
					: filteredEntries.length > PRACTICE_CAP
						? `Practicing the ${PRACTICE_CAP} newest of ${filteredEntries.length}`
						: undefined}
				onclick={() => onPractice(practiceEntries.map((entry) => entry.text))}
			>
				Practice these ({practiceEntries.length})
			</Button>
		</div>

		{#if entriesState.entries.length === 0}
			<p class="px-2 py-1 text-xs text-muted-foreground">
				Select text in the chat to save it as an entry.
			</p>
		{:else if filteredEntries.length === 0}
			<p class="px-2 py-1 text-xs text-muted-foreground">
				No {stageFilter} entries yet.
			</p>
		{:else}
			<Sidebar.Menu>
				{#each filteredEntries as entry (entry.id)}
					<Sidebar.MenuItem>
						<div class="flex w-full items-center gap-1.5 px-2 py-1">
							<span class="shrink-0 font-medium">{entry.text}</span>
							<input
								class="min-w-0 flex-1 bg-transparent text-xs text-muted-foreground outline-none"
								value={entry.note}
								placeholder="Note"
								onblur={(event) => commitNote(entry, event.currentTarget.value)}
							/>
							<button
								type="button"
								class="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase hover:bg-accent"
								title="Cycle stage: new, understood, usable"
								onclick={() => cycleStage(entry.id, entry.stage)}
							>
								{entry.stage}
							</button>
						</div>
						<Sidebar.MenuAction
							showOnHover
							aria-label="Delete entry"
							onclick={() => entriesState.remove(entry.id)}
						>
							<TrashIcon class="size-3.5" />
						</Sidebar.MenuAction>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		{/if}
	</Sidebar.GroupContent>
</Sidebar.Group>
