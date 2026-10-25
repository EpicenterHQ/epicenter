<script lang="ts">
	import type { Saved } from '@epicenter/folder/next';
	import { draft } from '@epicenter/svelte/folder-next';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Checkbox } from '@epicenter/ui/checkbox';

	let { value, label, disabled, save }: {
		value: unknown;
		label: string;
		disabled: boolean;
		save: (next: boolean) => Saved;
	} = $props();
	const input = draft(() => value === true, (next) => save(next));
</script>

<Checkbox aria-label={label} {disabled} bind:checked={input.value} />
<UnsavedEdit draft={input} />
