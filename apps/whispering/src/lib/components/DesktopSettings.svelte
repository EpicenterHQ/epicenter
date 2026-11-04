<!--
	Settings only the desktop app has: the data folder Whispering keeps its
	recordings in (where it is, Set up in Epicenter),
	the models that transcribe on this computer, and the global shortcut.
-->
<script lang="ts">
	import { APPS } from '@epicenter/definition/site';
	import { folderSync } from '@epicenter/svelte/folder-sync';
	import FolderSyncActions from '@epicenter/svelte/folder-sync-actions';
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import LocalModelAdministration from '@epicenter/transcription/local-model-administration';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { folder, shortcut as held, speech } from '../app.js';
	import { acceleratorOf, labelOf } from '../platform/shortcut.tauri.js';
	import { getWhispering } from '../whispering.svelte.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const sync = folderSync({ path: folder.displayPath() ?? '', site: APPS.WHISPERING.url });
	// The desktop always holds a global shortcut; only the web has none.
	const shortcut = held!;
	const whispering = getWhispering();

	// `speech` is the models on this computer: the same handle Whispering's models merge, so a download lists at once.
	/** The local model in use is Whispering's transcription choice, when it names one here. */
	const choice = {
		chosen() {
			const chosen = whispering.choice('transcription');
			return speech && chosen?.endpoint === speech.id ? chosen.model : null;
		},
		choose: (model: string) =>
			speech
				? whispering.choose('transcription', { endpoint: speech.id, model })
				: Promise.resolve('Nothing transcribes on this computer here.'),
	};

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

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Data folder</p>
	<FolderOnboarding noun="recordings" path={sync.path} pathTestId="desktop-folder-path" />
	<p class="text-muted-foreground">
		Plain files: a Markdown note per recording beside its audio. Whispering never syncs them;
		{#if sync.managed}Epicenter keeps this folder's local history.{:else}Epicenter can keep its history when you ask it to.{/if}
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<FolderSyncActions {sync} />
	</div>
</section>
<Separator />
<section class="flex flex-col gap-2 text-xs" data-testid="desktop-models">
	<p class="text-sm font-medium">On this computer</p>
	<p class="text-muted-foreground">
		Transcribe without sending audio anywhere: download a model here and use it for Transcription, or choose it below, where it is listed under On this computer.
	</p>
	{#if speech}<LocalModelAdministration {speech} {choice} />{/if}
</section>
<Separator />
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
