<script lang="ts">
	import type { Saved } from '@epicenter/folder/next';
	import { draft } from '@epicenter/svelte/folder-next';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import * as Select from '@epicenter/ui/select';
	import type { BoardLane } from './view.js';

	let { path, lane, lanes, disabled, save }: {
		path: string;
		lane: BoardLane;
		lanes: BoardLane[];
		disabled: boolean;
		save: (key: string) => Saved | undefined;
	} = $props();
	const move = draft(() => lane.key, async (key) => (await save(key)) ?? { data: undefined, error: null });
</script>

<Select.Root type="single" bind:value={move.value}>
	<Select.Trigger aria-label="Move {path}" {disabled}>{lanes.find((entry) => entry.key === move.value)?.label ?? move.value}</Select.Trigger>
	<Select.Content>{#each lanes.filter((entry) => entry.editable) as destination}<Select.Item value={destination.key}>{destination.label}</Select.Item>{/each}</Select.Content>
</Select.Root>
<UnsavedEdit draft={move} />
