<script lang="ts">
	import type { Saved } from '@epicenter/folder/next';
	import { draft } from '@epicenter/svelte/folder-next';
	import { Input } from '@epicenter/ui/input';

	let { value, kind, label, disabled, save }: {
		value: unknown;
		kind: string;
		label: string;
		disabled: boolean;
		save: (value: unknown) => Saved;
	} = $props();
	const shown = $derived(value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
	let invalid = $state<string | null>(null);
	const input = draft(() => shown, (text) => save(kind === 'number' || kind === 'integer' ? Number(text) : text));
	function set(text: string) {
		if ((kind === 'number' || kind === 'integer') && (text === '' || !Number.isFinite(Number(text)))) {
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
	bind:value={() => invalid ?? input.text, set}
	onblur={() => invalid = null}
/>
