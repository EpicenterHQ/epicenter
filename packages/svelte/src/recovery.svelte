<!-- A desktop root that did not open shows its error and lets the person retry. -->
<script lang="ts">
	import type { OpenDeviceError } from '@epicenter/folder/tauri';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { assertNever } from '@epicenter/ui/utils/assert-never';

	const {
		app,
		error,
		appDataError = false,
		retry,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** Why the root did not open. */
		error: OpenDeviceError;
		/** Whether the AppData root failed before the data folder opened. */
		appDataError?: boolean;
		/** Open the roots again. */
		retry: () => void;
	} = $props();

	const retrying = $derived($effect.pending() > 0);
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
	<Button disabled={retrying} onclick={() => retry()}>{retrying ? 'Retrying…' : 'Retry'}</Button>
{/snippet}

<main class="mx-auto flex w-full max-w-xl flex-col gap-5 px-6 py-12" data-testid="recovery">
	{#if appDataError}
		{@render screen(`${app} could not open its own settings`, error.message)}
	{:else if error.name === 'Disconnected'}
		{@render screen(`${app}'s folder isn't available`, error.message)}
	{:else if error.name === 'Refused'}
		{@render screen(`That folder cannot be ${app}'s folder`, error.message)}
	{:else if error.name === 'Unreadable'}
		{@render screen(`${app} could not open its folder`, error.message)}
	{:else if error.name === 'StorageUnavailable'}
		{@render screen(`${app} could not reach its files`, error.message)}
	{:else}
		{assertNever(error)}
	{/if}
	<div class="flex flex-wrap gap-2">{@render retryButton()}</div>
</main>
