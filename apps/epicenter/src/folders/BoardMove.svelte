<script lang="ts">
	import type { Saved } from '@epicenter/folder';
	import * as Select from '@epicenter/ui/select';
	import type { BoardLane } from './view.js';

	let { path, lane, lanes, disabled, save }: {
		path: string;
		lane: BoardLane;
		lanes: BoardLane[];
		disabled: boolean;
		save: (key: string) => Saved | undefined;
	} = $props();
	let problem = $state<string>();
	async function move(key: string) {
		problem = undefined;
		const saved = save(key);
		if (saved === undefined) return;
		const { error } = await saved;
		if (error !== null) problem = error.message;
	}
</script>

<Select.Root type="single" value={lane.key} onValueChange={(key) => void move(key)}>
	<Select.Trigger aria-label="Move {path}" {disabled}>{lane.label}</Select.Trigger>
	<Select.Content>{#each lanes.filter((entry) => entry.editable) as destination}<Select.Item value={destination.key}>{destination.label}</Select.Item>{/each}</Select.Content>
</Select.Root>
{#if problem}<p role="alert" class="text-xs text-destructive">Move failed: {problem}</p>{/if}
