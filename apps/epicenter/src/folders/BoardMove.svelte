<script lang="ts">
	import type { Saved } from '@epicenter/folder/next';
	import * as Select from '@epicenter/ui/select';
	import type { BoardLane } from './view.js';

	let { path, lane, lanes, disabled, save }: {
		path: string;
		lane: BoardLane;
		lanes: BoardLane[];
		disabled: boolean;
		save: (key: string) => Saved | undefined;
	} = $props();
	let pending = $state<string | undefined>();
	let lastSave: Saved | undefined;
	function set(key: string) {
		const saved = save(key);
		if (!saved) return;
		pending = key;
		lastSave = saved;
		void saved.then(() => { if (lastSave === saved) pending = undefined; });
	}
</script>

<Select.Root type="single" bind:value={() => pending ?? lane.key, set}>
	<Select.Trigger aria-label="Move {path}" {disabled}>{lane.label}</Select.Trigger>
	<Select.Content>{#each lanes.filter((entry) => entry.editable) as destination}<Select.Item value={destination.key}>{destination.label}</Select.Item>{/each}</Select.Content>
</Select.Root>
