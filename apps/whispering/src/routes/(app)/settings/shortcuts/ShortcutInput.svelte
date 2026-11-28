<!--
	One shortcut's keys, as a button. Pressing it reads the next key press as
	the new shortcut: modifiers and one key, or a function key alone. Escape
	or a click elsewhere leaves it as it was. While it reads, every global
	shortcut is let go, so pressing the old keys starts nothing.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import XIcon from '@lucide/svelte/icons/x';
	import { isMac, shortcutLabel, shortcutOf } from '#lib/shortcut.ts';
	import { shortcutHolds } from '#lib/shortcut-holds.svelte.ts';
	import Key from '../../Key.svelte';

	let {
		id,
		keys,
		removable = false,
		disabled = false,
		onchange,
	}: {
		id?: string;
		/** The shortcut now; empty for none. */
		keys: string;
		/** Whether the shortcut may be turned off. */
		removable?: boolean;
		disabled?: boolean;
		/** Hears the new shortcut, or an empty string when it is removed. */
		onchange: (keys: string) => void;
	} = $props();

	let reading = $state(false);

	$effect(() => {
		if (!reading) return;
		shortcutHolds.pause(true);
		const read = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.code === 'Escape') return void (reading = false);
			const pressed = shortcutOf(event);
			if (!pressed) return;
			reading = false;
			if (pressed !== keys) onchange(pressed);
		};
		window.addEventListener('keydown', read, true);
		return () => {
			window.removeEventListener('keydown', read, true);
			shortcutHolds.pause(false);
		};
	});
</script>

<Button
	{id}
	variant="outline"
	size="sm"
	class="min-w-24"
	aria-label={reading ? 'Press the new shortcut' : `Change shortcut${keys ? `, now ${shortcutLabel(keys, isMac())}` : ''}`}
	{disabled}
	onclick={() => (reading = !reading)}
	onblur={() => (reading = false)}
>
	{#if reading}
		<span class="text-muted-foreground">Press the keys…</span>
	{:else if keys}
		<Key keys={shortcutLabel(keys, isMac())} class="border-0 bg-transparent px-0" />
	{:else}
		<span class="text-muted-foreground">Set a shortcut</span>
	{/if}
</Button>
{#if removable && keys && !reading}
	<Button variant="ghost" size="icon-sm" aria-label="Remove this shortcut" {disabled} onclick={() => onchange('')}>
		<XIcon />
	</Button>
{/if}
