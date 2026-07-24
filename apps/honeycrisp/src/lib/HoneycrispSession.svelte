<!--
	One data session. The parent layout keys this component on the
	authenticated identity (ADR-0178: sign-in selects a replica), so a login
	or logout tears the whole session down and boots the newly selected
	replica. Within one key, the app is acquired exactly once and disposed on
	unmount.
-->
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Snippet } from 'svelte';
	import HoneycrispAppProvider from './HoneycrispAppProvider.svelte';
	import { openHoneycrispApplication } from './application.js';
	import { honeycrispPlatform } from './application-platform.js';

	let { children }: { children: Snippet } = $props();

	const boot = new AbortController();
	const opening = openHoneycrispApplication(honeycrispPlatform, {
		signal: boot.signal,
	});
	$effect(() => () => boot.abort());
</script>

{#await opening}
	<Loading class="h-dvh" />
{:then application}
	<HoneycrispAppProvider {application}>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
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
