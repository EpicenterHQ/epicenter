<script lang="ts" generics="K extends string">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';

	// A numeric settings field over whichever store is passed (synced
	// `settings` or device-local `deviceConfig`). The store value is a string
	// so empty stays empty: blank means "unset, use the library default", and
	// we never coerce a cleared field to 0. Writes go through `set` on blur.
	let {
		store,
		key,
		label,
		description,
		placeholder,
		min,
		max,
		step,
	}: {
		store: {
			get(key: NoInfer<K>): string;
			set(key: NoInfer<K>, value: string): void;
		};
		key: K;
		label: string;
		description?: string;
		placeholder?: string;
		min?: number;
		max?: number;
		step?: number;
	} = $props();

	const id = $props.id();
</script>

<Field.Field>
	<Field.Label for={id}>{label}</Field.Label>
	<Input
		{id}
		type="number"
		{min}
		{max}
		{step}
		{placeholder}
		autocomplete="off"
		value={store.get(key)}
		onblur={(e) => {
			const next = e.currentTarget.value;
			if (next !== store.get(key)) store.set(key, next);
		}}
	/>
	{#if description}
		<Field.Description>{description}</Field.Description>
	{/if}
</Field.Field>
