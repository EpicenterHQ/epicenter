<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toastOnError } from '@epicenter/ui/sonner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { createQuery } from '@tanstack/svelte-query';
	import { mode, toggleMode } from 'mode-watcher';
	import { getDashboard } from '$lib/dashboard/context';
	import { auth } from '$lib/platform/auth';

	const { billing, accountQueries } = getDashboard();
	const session = createQuery(() => accountQueries.session.options);
	const overview = createQuery(() => billing.overview.options);

	const planName = $derived(overview.data?.planDisplayName);
	const isOnTrial = $derived(overview.data?.trial != null);

	async function signOut() {
		const result = await auth.signOut();
		if (result.error) toastOnError(result, 'Failed to sign out');
	}

	const isDark = $derived(mode.current === 'dark');
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" aria-label="Account menu">
				<span class="max-w-40 truncate sm:max-w-56">
					{session.data?.user.email ?? (session.isError ? 'Account unavailable' : 'Loading account…')}
				</span>
				<ChevronDownIcon class="size-4 text-muted-foreground" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end" class="w-64">
		<DropdownMenu.Label class="font-normal">
			<div class="flex flex-col gap-1">
				<p class="wrap-anywhere text-sm font-medium">
					{session.data?.user.email ?? 'Epicenter account'}
				</p>
				{#if planName || isOnTrial}
					<div class="flex items-center gap-1.5">
						{#if planName}<Badge variant="secondary">{planName}</Badge>{/if}
						{#if isOnTrial}<Badge variant="outline">Trial</Badge>{/if}
					</div>
				{/if}
			</div>
		</DropdownMenu.Label>

		<DropdownMenu.Separator />

		<DropdownMenu.Group>
			{#if session.isError}
				<DropdownMenu.Item disabled={session.isFetching} onclick={() => session.refetch()}>Retry account</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item closeOnSelect={false} onSelect={toggleMode}>
				{#if isDark}
					<SunIcon class="size-4" />
					Light mode
				{:else}
					<MoonIcon class="size-4" />
					Dark mode
				{/if}
			</DropdownMenu.Item>
		</DropdownMenu.Group>

		<DropdownMenu.Separator />

		<DropdownMenu.Item onclick={signOut}>
			<LogOutIcon class="size-4" />
			Sign out
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
