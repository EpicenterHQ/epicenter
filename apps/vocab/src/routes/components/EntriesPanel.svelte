<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { Entry } from '$lib/data';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { getVocabSurface } from '$lib/surface';

	const { entries } = getVocabSurface();

	const STAGES = ['new', 'recognized', 'understood', 'usable'] as const;
	const STAGE_LABELS: Record<Entry['stage'], string> = {
		new: 'New',
		recognized: 'Recognize',
		understood: 'Understand',
		usable: 'Use',
	};
	const STAGE_FILTERS = ['all', ...STAGES] as const;
	type StageFilter = (typeof STAGE_FILTERS)[number];
	let stageFilter = $state<StageFilter>('all');

	const filteredEntries = $derived(
		stageFilter === 'all'
			? entries.entries
			: entries.entries.filter((entry) => entry.stage === stageFilter),
	);

	let newEntry = $state('');

	function addEntry() {
		if (entries.save(newEntry)) {
			newEntry = '';
		}
	}

	function commitNote(entry: Entry, note: string) {
		if (note !== entry.note) entries.setNote(entry.id, note);
	}
</script>

<Sidebar.Group class="group-data-[collapsible=icon]:hidden">
	<Sidebar.GroupLabel>
		<span>Entries</span>
		<span class="ml-auto text-xs text-muted-foreground">
			usable: {entries.usableCount}
		</span>
	</Sidebar.GroupLabel>
	<Sidebar.GroupContent>
		<form
			class="flex items-center gap-1 px-2 py-1"
			onsubmit={(event) => {
				event.preventDefault();
				addEntry();
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
						{filter === 'all' ? 'All' : STAGE_LABELS[filter]}
				</button>
			{/each}
		</div>

		{#if entries.entries.length === 0}
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
							<select
								class="max-w-28 shrink-0 rounded-sm border bg-background px-1 py-0.5 text-[10px]"
								aria-label="Familiarity with {entry.text}"
								value={entry.stage}
								onchange={(event) => entries.setStage(entry.id, event.currentTarget.value as Entry['stage'])}
							>
								{#each STAGES as stage (stage)}
									<option value={stage}>{STAGE_LABELS[stage]}</option>
								{/each}
							</select>
						</div>
						<Sidebar.MenuAction
							showOnHover
							aria-label="Delete entry"
							onclick={() => entries.remove(entry.id)}
						>
							<TrashIcon class="size-3.5" />
						</Sidebar.MenuAction>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		{/if}
	</Sidebar.GroupContent>
</Sidebar.Group>
