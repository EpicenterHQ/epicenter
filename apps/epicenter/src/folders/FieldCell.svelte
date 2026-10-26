<script lang="ts">
	import type { Saved } from '@epicenter/folder';
	import { draft } from '@epicenter/svelte/folder';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
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
<UnsavedEdit draft={input} />
