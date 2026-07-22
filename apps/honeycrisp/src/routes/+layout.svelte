<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import HoneycrispAppProvider from '$lib/HoneycrispAppProvider.svelte';
	import HoneycrispIdentityGate from '$lib/HoneycrispIdentityGate.svelte';
	import { openHoneycrispApplication } from '$lib/application.js';
	import { honeycrispPlatform } from '$lib/application-platform.js';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	const boot = new AbortController();
	const opening = openHoneycrispApplication(honeycrispPlatform, {
		signal: boot.signal,
	});
	$effect(() => () => boot.abort());
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#await opening}
	<Loading class="h-dvh" />
{:then application}
	<HoneycrispAppProvider {application}>
		<HoneycrispIdentityGate>
			<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
		</HoneycrispIdentityGate>
	</HoneycrispAppProvider>
{:catch error}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="max-w-md space-y-2">
			<h1 class="text-lg font-semibold">Honeycrisp could not start</h1>
			<p class="text-sm text-muted-foreground">
				{error instanceof Error ? error.message : String(error)}
			</p>
		</div>
	</div>
{/await}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
