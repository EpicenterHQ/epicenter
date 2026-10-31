<!--
	A standalone desktop app's first run (decisions 81 and 82): where should
	the app keep its files? The Epicenter folder (recommended, visible), the
	app data folder (hidden), or a folder the person picks. The shell admits
	the answer or says in one line why not, then the app moves there in a new
	window, which records the folder in its settings.md. Shown again, with
	why, when the remembered folder is missing or refused.
-->
<script lang="ts">
	import type { DesktopFolder, FolderPlace } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import * as Item from '@epicenter/ui/item';

	let {
		app,
		folder,
		kept = 'Your files are kept in this folder.',
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** The window's folder, or null when the shell gave this window none. */
		folder: Omit<DesktopFolder, 'config'> | null;
		/** What the app keeps there, in one sentence. */
		kept?: string;
	} = $props();

	let choosing = $state(false);
	let refusal = $state<string>();

	async function choose(place: FolderPlace) {
		if (folder === null) return;
		choosing = true;
		refusal = undefined;
		const answer = await folder.choose(place);
		choosing = false;
		if (!answer.ok) refusal = answer.message;
	}
</script>

<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
	<header class="flex flex-col gap-1.5">
		<h1 class="text-lg font-semibold">Where should {app} keep its files?</h1>
		<p class="text-sm text-muted-foreground">
			{kept} The files stay if you remove the app, and you can choose another folder later.
		</p>
	</header>

	{#if folder === null}
		<Alert.Root variant="destructive">
			<Alert.Title>This window has no folder</Alert.Title>
			<Alert.Description>{app}'s desktop shell did not give this window its folders. Quit and open {app} again.</Alert.Description>
		</Alert.Root>
	{:else}
		{#if folder.problem !== null}
			<Alert.Root>
				<Alert.Title>Choose {app}'s folder again</Alert.Title>
				<Alert.Description>{folder.problem}</Alert.Description>
			</Alert.Root>
		{/if}
		<Item.Group aria-label="Where to keep {app}'s files" class="gap-2">
			<Item.Button variant="outline" disabled={choosing} onclick={() => void choose('epicenter')}>
				<Item.Content>
					<Item.Title>Epicenter folder (recommended)</Item.Title>
					<Item.Description class="break-all text-xs">{folder.places.epicenter}, where you can see them</Item.Description>
				</Item.Content>
			</Item.Button>
			<Item.Button variant="outline" disabled={choosing} onclick={() => void choose('app-data')}>
				<Item.Content>
					<Item.Title>App data folder</Item.Title>
					<Item.Description class="break-all text-xs">{folder.places.appData}, out of sight</Item.Description>
				</Item.Content>
			</Item.Button>
			<Item.Button variant="outline" disabled={choosing} onclick={() => void choose('pick')}>
				<Item.Content>
					<Item.Title>Choose folder…</Item.Title>
					<Item.Description class="text-xs">Anywhere else on this computer</Item.Description>
				</Item.Content>
			</Item.Button>
		</Item.Group>
		{#if refusal !== undefined}
			<p role="alert" class="text-sm text-destructive">{refusal}</p>
		{/if}
	{/if}
</main>
