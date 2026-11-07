<!--
	"Import from Git…" (ADR-0826): choose a Git repository on this computer
	and make a folder of its history, in the Epicenter folder and synced. The
	original is left as it was unless the person asks to replace it: then it
	moves aside, its `.git` kept within it, and a link at its path points to
	the new folder. `importGit` in `@epicenter/folder/platform` runs the
	import over the shell's Git (`git-host.ts`).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { commands } from '../ui/bindings.gen';
	import { folders } from './home.svelte';

	let { open = $bindable() }: { open: boolean } = $props();

	let source = $state('');
	let replaceOriginal = $state(false);
	let importing = $state(false);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Import from Git</Dialog.Title>
			<Dialog.Description>
				Make a folder of a Git repository's history: each commit of its main branch becomes a change, with its author, time, and message, and each tag a mark.
			</Dialog.Description>
		</Dialog.Header>

		<form
			class="flex flex-col gap-4"
			onsubmit={async (event) => {
				event.preventDefault();
				importing = true;
				const done = await folders.importFromGit(source, replaceOriginal);
				importing = false;
				if (done) {
					source = '';
					replaceOriginal = false;
					open = false;
				}
			}}
		>
			<Field.Field>
				<Field.Label for="git-source">Repository</Field.Label>
				<div class="flex gap-2">
					<Input id="git-source" placeholder="A folder on this computer, or a URL" bind:value={source} disabled={importing} />
					<Button
						type="button"
						variant="outline"
						disabled={importing}
						onclick={async () => {
							const chosen = await commands.chooseRepository();
							if (chosen.error !== null) return void toast.error(chosen.error);
							if (chosen.data !== null) source = chosen.data;
						}}
					>
						Choose…
					</Button>
				</div>
			</Field.Field>

			<Field.Field orientation="horizontal">
				<Checkbox id="replace-original" bind:checked={replaceOriginal} disabled={importing} />
				<Field.Content>
					<Field.Label for="replace-original">Replace the original</Field.Label>
					<Field.Description>
						Move the repository aside, its Git history kept within it, and leave a link where it was to the new folder. It must have no uncommitted changes.
					</Field.Description>
				</Field.Content>
			</Field.Field>

			<Dialog.Footer>
				<Button type="submit" disabled={importing || source.trim() === '' || folders.account() === null}>
					{importing ? 'Importing…' : 'Import'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
