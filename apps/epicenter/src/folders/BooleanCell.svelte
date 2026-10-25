<script lang="ts">
	import type { Saved } from '@epicenter/folder/next';
	import { Checkbox } from '@epicenter/ui/checkbox';

	let { value, label, disabled, save }: {
		value: unknown;
		label: string;
		disabled: boolean;
		save: (next: boolean) => Saved;
	} = $props();
	let pending = $state<boolean | undefined>();
	let lastSave: Saved | undefined;
	function set(next: boolean) {
		pending = next;
		const saved = lastSave = save(next);
		void saved.then(() => { if (lastSave === saved) pending = undefined; });
	}
</script>

<Checkbox aria-label={label} {disabled} bind:checked={() => pending ?? value === true, set} />
