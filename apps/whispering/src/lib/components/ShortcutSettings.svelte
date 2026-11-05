<!--
	The global shortcut, where there is one (`shortcut`, null in a browser):
	the key that starts and stops a recording from any app, where it is set,
	and a field that records the next one.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { acceleratorOf, type GlobalShortcut, labelOf } from '../shortcut.js';

	let { shortcut }: { shortcut: GlobalShortcut } = $props();

	/** The keys the person pressed and has not saved; none shows the shortcut as resolved. */
	let typed = $state<string>();

	/**
	 * Record the keys pressed in the field as the next shortcut. Tab with no
	 * modifier still moves on, and Escape lets go of what was pressed.
	 */
	function press(event: KeyboardEvent) {
		const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
		if (bare && event.key === 'Tab') return;
		event.preventDefault();
		if (bare && event.key === 'Escape') {
			typed = undefined;
			return;
		}
		const pressed = acceleratorOf(event);
		if (pressed !== undefined) typed = pressed;
	}
	/** Where the person chose to save it; none follows where the shortcut is set now. */
	let here = $state<boolean>();
	let saving = $state(false);
	/** Why the last save did not land. */
	let unsaved = $state<string | null>(null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		unsaved = await shortcut.save(typed ?? shortcut.accelerator(), {
			onThisComputer: here ?? shortcut.onThisComputer(),
		});
		saving = false;
		if (unsaved === null) {
			typed = undefined;
			here = undefined;
		}
	}
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-shortcut">
	<p class="text-sm font-medium">Shortcut</p>
	<p class="text-muted-foreground">
		<kbd class="rounded border px-1" data-testid="shortcut-label">{shortcut.label()}</kbd> starts and stops a recording from any app.
	</p>
	<form class="flex flex-col gap-2" onsubmit={save}>
		<Label for="global-shortcut" class="font-normal">Press the keys here: a modifier and a key, or a function key</Label>
		<div class="flex items-center gap-2">
			<Input
				id="global-shortcut"
				class="h-8 font-mono text-xs"
				readonly
				spellcheck={false}
				autocomplete="off"
				disabled={!shortcut.read() || saving}
				value={labelOf(typed ?? shortcut.accelerator())}
				onkeydown={press}
				data-accelerator={typed ?? shortcut.accelerator()}
				data-testid="shortcut-input"
			/>
			<Button size="sm" variant="outline" type="submit" disabled={!shortcut.read() || saving} data-testid="shortcut-save">Save</Button>
		</div>
		<div class="flex items-center gap-2">
			<Checkbox
				id="shortcut-this-computer"
				bind:checked={() => here ?? shortcut.onThisComputer(), (checked) => (here = checked)}
				disabled={!shortcut.read() || saving}
				data-testid="shortcut-this-computer"
			/>
			<Label for="shortcut-this-computer" class="font-normal">Only on this computer</Label>
		</div>
	</form>
	<p class="text-muted-foreground">
		Kept in <code>shortcuts.md</code>: the data folder's goes wherever your files go;
		“Only on this computer” keeps it in this computer's settings instead, ahead of the data folder's.
	</p>
	{#if unsaved ?? shortcut.problem()}
		<p class="text-destructive" role="alert" data-testid="shortcut-problem">{unsaved ?? shortcut.problem()}</p>
	{/if}
</section>
