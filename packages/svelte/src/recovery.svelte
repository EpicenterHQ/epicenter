<!--
	A standalone desktop app's recovery screen, when a root did not open
	(decision 94). Without `appData` the app could not open its own settings,
	and Retry is all it offers. With it, the data folder did not open: each
	`OpenDeviceError` case says what happened and offers what fixes it, each
	action writing or clearing `folder` in the AppData `settings.md` and then
	retrying. It never opens another folder on its own.

	```svelte
	{#if appData.error}
		<Recovery app="Capture" error={appData.error} {retry} />
	{:else if device.error}
		<Recovery app="Capture" error={device.error} appData={appData.data} {retry} />
	{/if}
	```
-->
<script lang="ts">
	import {
		type FolderSettings,
		type OpenDeviceError,
		pickDataFolder,
		rememberFolder,
	} from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { assertNever } from '@epicenter/ui/utils/assert-never';

	const {
		app,
		error,
		appData,
		retry,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** Why the root did not open. */
		error: OpenDeviceError;
		/** The AppData root's client, when it opened: the data folder did not. */
		appData?: FolderSettings;
		/** Open the roots again. */
		retry: () => void;
	} = $props();

	/** Why the last action could not write the settings, if it could not. */
	let problem = $state<string>();
	let acting = $state(false);
	const retrying = $derived($effect.pending() > 0);
	const busy = $derived(acting || retrying);

	/** The native picker at `at`; picking a folder allows it and remembers it, then the roots open again. */
	async function pick(settings: FolderSettings, title: string, at?: string) {
		acting = true;
		problem = undefined;
		const picked = await pickDataFolder(settings, { title, at });
		if (picked.error !== null) problem = picked.error.message;
		else if (picked.data) retry();
		acting = false;
	}

	/** Forget `folder`, then open the roots again over the default. */
	async function useDefault(settings: FolderSettings) {
		acting = true;
		problem = undefined;
		const { error: failed } = await rememberFolder(settings, undefined);
		if (failed !== null) problem = `settings.md: ${failed.message}`;
		else retry();
		acting = false;
	}
</script>

{#snippet screen(title: string, message: string)}
	<header class="flex flex-col gap-1.5">
		<h1 class="text-lg font-semibold">{title}</h1>
		<p class="text-sm text-muted-foreground">Nothing was moved, and no other folder was opened instead.</p>
	</header>
	<Alert.Root variant="destructive">
		<Alert.Description class="break-all">{message}</Alert.Description>
	</Alert.Root>
{/snippet}

{#snippet retryButton()}
	<Button disabled={busy} onclick={() => retry()}>{retrying ? 'Retrying…' : 'Retry'}</Button>
{/snippet}

{#snippet chooseButton(settings: FolderSettings)}
	<Button variant="outline" disabled={busy} onclick={() => void pick(settings, `Choose ${app}'s data folder`)}>Choose folder…</Button>
{/snippet}

{#snippet defaultButton(settings: FolderSettings)}
	<Button variant="outline" disabled={busy} onclick={() => void useDefault(settings)}>Use the default folder</Button>
{/snippet}

<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12" data-testid="recovery">
	{#if appData === undefined}
		{@render screen(`${app} could not open its own settings`, error.message)}
		<div class="flex flex-wrap gap-2">{@render retryButton()}</div>
	{:else}
		{@const settings = appData}
		{#if error.name === 'NotGranted'}
			{@render screen(`${app} needs your permission to open its folder`, error.message)}
			<div class="flex flex-wrap gap-2">
				<Button disabled={busy} onclick={() => void pick(settings, `Allow ${app} to open this folder`, error.folder)}>Allow access</Button>
				{@render chooseButton(settings)}
				{@render defaultButton(settings)}
			</div>
		{:else if error.name === 'Missing'}
			{@render screen(`${app}'s folder is missing`, error.message)}
			<div class="flex flex-wrap gap-2">
				{@render retryButton()}
				{@render chooseButton(settings)}
				{@render defaultButton(settings)}
			</div>
		{:else if error.name === 'Refused'}
			{@render screen(`That folder cannot be ${app}'s folder`, error.message)}
			<div class="flex flex-wrap gap-2">
				{@render chooseButton(settings)}
				{@render defaultButton(settings)}
			</div>
		{:else if error.name === 'Unreadable'}
			{@render screen(`${app} could not open its folder`, error.message)}
			<div class="flex flex-wrap gap-2">
				{@render retryButton()}
				{@render chooseButton(settings)}
				{@render defaultButton(settings)}
			</div>
		{:else if error.name === 'StorageUnavailable'}
			{@render screen(`${app} could not reach its files`, error.message)}
			<div class="flex flex-wrap gap-2">{@render retryButton()}</div>
		{:else}
			{assertNever(error)}
		{/if}
	{/if}
	{#if problem !== undefined}
		<p role="alert" class="break-all text-sm text-destructive">{problem}</p>
	{/if}
</main>
