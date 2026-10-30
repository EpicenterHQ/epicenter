<script lang="ts">
	import type { Saved } from '@epicenter/folder';
	import { Checkbox } from '@epicenter/ui/checkbox';

	let { value, label, disabled, save }: {
		value: unknown;
		label: string;
		disabled: boolean;
		save: (next: boolean) => Saved;
	} = $props();
	let problem = $state<string>();
	async function change(next: boolean) {
		problem = undefined;
		const { error } = await save(next);
		if (error !== null) problem = error.message;
	}
</script>

<Checkbox aria-label={label} {disabled} bind:checked={() => value === true, (next) => void change(next === true)} />
{#if problem}<p role="alert" class="text-xs text-destructive">Change failed: {problem}</p>{/if}
