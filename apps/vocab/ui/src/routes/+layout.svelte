<!--
	Every page of Vocab: the client that keeps what pages show current, the
	tabs with the count of words due, the toasts, the delete confirmation, and
	the system's light or dark mode.
-->
<script lang="ts">
	import { createQueryClient } from '@epicenter/app/client';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { cn } from '@epicenter/ui/utils';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { QueryClientProvider, createQuery } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { reads } from '$lib/app.js';
	import '../app.css';

	let { children } = $props();

	const queryClient = createQueryClient();
	// The layout makes the client, so it is not yet in context here.
	const due = createQuery(() => reads.due(), () => queryClient);
	const dueCount = $derived(due.data?.length ?? 0);

	const tabs = [
		{ href: resolve('/'), label: 'Review', icon: LayersIcon, routes: ['/'] },
		{ href: resolve('/words'), label: 'Words', icon: BookOpenIcon, routes: ['/words', '/[...path]'] },
		{ href: resolve('/add'), label: 'Add', icon: PlusIcon, routes: ['/add'] },
	];
</script>

<svelte:head><title>Vocab</title></svelte:head>

<Tooltip.Provider>
	<div
		class="flex min-h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
	>
		<!-- One nav: a tab bar at the bottom on a phone, a header on a wider screen. -->
		<nav
			aria-label="Vocab"
			class="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:sticky md:top-0 md:order-first md:border-t-0 md:border-b md:pb-0"
		>
			<div class="mx-auto flex max-w-2xl items-stretch md:items-center md:gap-1 md:px-4 md:py-2">
				<span class="mr-auto hidden font-semibold md:block">Vocab</span>
				{#each tabs as tab (tab.href)}
					{@const current = tab.routes.includes(page.route.id ?? '')}
					<a
						href={tab.href}
						aria-current={current ? 'page' : undefined}
						class={cn(
							'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors md:min-h-9 md:flex-none md:flex-row md:gap-1.5 md:rounded-md md:px-3 md:text-sm md:hover:bg-muted',
							current && 'text-foreground md:bg-muted',
						)}
					>
						<span class="relative">
							<tab.icon class="size-5 md:size-4" aria-hidden="true" />
							{#if tab.label === 'Review' && dueCount > 0}
								<span
									class="absolute -top-1.5 left-3.5 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 text-primary-foreground md:hidden"
									aria-hidden="true">{dueCount}</span
								>
							{/if}
						</span>
						{tab.label}
						{#if tab.label === 'Review' && dueCount > 0}
							<span class="sr-only">, {dueCount} due</span>
							<span class="hidden text-muted-foreground tabular-nums md:inline" aria-hidden="true"
								>{dueCount}</span
							>
						{/if}
					</a>
				{/each}
			</div>
		</nav>

		<main class="flex flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
			<QueryClientProvider client={queryClient}>
				{@render children()}
			</QueryClientProvider>
		</main>
	</div>

	<ConfirmationDialog />
	<Toaster offset={16} closeButton position="top-center" />
	<ModeWatcher />
</Tooltip.Provider>
