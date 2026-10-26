<script lang="ts">
	import type { Saved } from '@epicenter/folder';
	import { edit } from '@epicenter/svelte/folder';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Input } from '@epicenter/ui/input';
	import { onMount } from 'svelte';

	let { value, kind, label, disabled, save, register }: {
		value: unknown;
		kind: string;
		label: string;
		disabled: boolean;
		save: (value: unknown) => Saved;
		register?: (landed: () => Promise<boolean>) => () => void;
	} = $props();
	const shown = $derived(value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
	let invalid = $state<string | null>(null);
	const input = edit(() => shown, (text) => save(kind === 'number' || kind === 'integer' ? Number(text) : text));
	onMount(() => register?.(async () => (await input.landed()).error === null));
	function set(value: string | number | null) {
		const text = value === null ? '' : String(value);
		if ((kind === 'number' || kind === 'integer') && (value === null || text === '' || !Number.isFinite(Number(text)))) {
			invalid = text;
			return;
		}
		invalid = null;
		input.set(text);
	}
</script>

<Input
	aria-label={label}
	{disabled}
	type={kind === 'number' || kind === 'integer' ? 'number' : 'text'}
	bind:value={() => invalid ?? input.value, set}
	onblur={() => invalid = null}
/>
<UnsavedEdit edit={input} />
