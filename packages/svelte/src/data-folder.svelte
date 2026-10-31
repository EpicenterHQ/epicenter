<!--
	A standalone desktop app's data root (decisions 88 and 89), opened as the
	window starts: the folder `settings.md` names, or the default
	`~/Epicenter/<App>`. Open, it sets the app's client over the folder for
	every component under it (`setRepo`, the same client type as the web's
	repository), and the header's `getFolderSync()` reads its sync. Refused, it shows what failed
	and offers Retry, Choose folder…, and Use the default folder; it never
	opens another folder on its own.
-->
<script lang="ts">
	import type { Contract } from '@epicenter/definition/contract';
	import type { DataFolder, DataFolderAnswer, DataFolderRefusal, DesktopFolder } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import OpenFolder from './open-data-folder.svelte';

	const {
		app,
		contract,
		desktop,
		kept = 'Your files are kept in this folder.',
		children,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** The app's contract, whose client over the folder the app reads and edits. */
		contract: Contract;
		/** The window's roots, or null when the shell gave this window none. */
		desktop: Pick<DesktopFolder, 'open' | 'openDefault' | 'choose' | 'defaultPath'> | null;
		/** What the app keeps there, in one sentence. */
		kept?: string;
		/** The app over its open data folder. */
		children: Snippet;
	} = $props();

	type Opening =
		| { status: 'opening' }
		| { status: 'open'; folder: DataFolder }
		| { status: 'failed'; refusal: DataFolderRefusal };

	let opening = $state<Opening>({ status: 'opening' });
	let busy = $state(false);

	const titles: Record<DataFolderRefusal['kind'], string> = {
		missing: 'The folder is missing',
		refused: 'That folder cannot be used',
		unavailable: 'The folder could not be opened',
		settings: 'The settings could not be read',
	};

	async function run(request: () => Promise<DataFolderAnswer | null>) {
		busy = true;
		const answer = await request();
		busy = false;
		if (answer === null) return;
		opening = answer.ok ? { status: 'open', folder: answer.folder } : { status: 'failed', refusal: answer.refusal };
	}

	// Opened once, as the window starts.
	// svelte-ignore state_referenced_locally
	if (desktop !== null) void run(() => desktop.open());
</script>

{#if desktop === null}
	<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
		<Alert.Root variant="destructive">
			<Alert.Title>This window has no folders</Alert.Title>
			<Alert.Description>{app}'s desktop shell did not give this window its folders. Quit and open {app} again.</Alert.Description>
		</Alert.Root>
	</main>
{:else if opening.status === 'opening'}
	<Loading class="h-dvh" label="Opening {app}'s folder…" />
{:else if opening.status === 'failed'}
	<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12">
		<header class="flex flex-col gap-1.5">
			<h1 class="text-lg font-semibold">{app} could not open its data folder</h1>
			<p class="text-sm text-muted-foreground">{kept} Nothing was moved, and no other folder was opened instead.</p>
		</header>
		<Alert.Root variant="destructive">
			<Alert.Title>{titles[opening.refusal.kind]}</Alert.Title>
			<Alert.Description class="break-all">{opening.refusal.message}</Alert.Description>
		</Alert.Root>
		<div class="flex flex-wrap gap-2">
			<Button disabled={busy} onclick={() => void run(() => desktop.open())}>Retry</Button>
			<Button variant="outline" disabled={busy} onclick={() => void run(() => desktop.choose())}>Choose folder…</Button>
			<Button variant="outline" disabled={busy} onclick={() => void run(() => desktop.openDefault())}>Use the default folder</Button>
		</div>
		<p class="break-all text-xs text-muted-foreground">The default folder is {desktop.defaultPath}.</p>
	</main>
{:else}
	<OpenFolder {contract} {desktop} folder={opening.folder}>{@render children()}</OpenFolder>
{/if}
