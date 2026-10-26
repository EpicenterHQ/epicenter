<script lang="ts">
	import type { Saved } from '@epicenter/folder';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { onMount } from 'svelte';

	let { value, label, disabled, save, register }: {
		value: unknown;
		label: string;
		disabled: boolean;
		save: (next: boolean) => Saved;
		register?: (landed: () => Promise<boolean>) => () => void;
	} = $props();
	let problem = $state<string>();
	let pending: Promise<void> | undefined;
	onMount(() => register?.(async () => {
		await pending;
		return problem === undefined;
	}));
	async function change(next: boolean) {
		problem = undefined;
		pending = (async () => {
			const { error } = await save(next);
			if (error !== null) problem = error.message;
		})();
		await pending;
	}
</script>

<Checkbox aria-label={label} {disabled} bind:checked={() => value === true, (next) => void change(next === true)} />
{#if problem}<p role="alert" class="text-xs text-destructive">Change failed: {problem}</p>{/if}
