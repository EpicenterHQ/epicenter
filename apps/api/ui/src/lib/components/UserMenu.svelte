<script lang="ts">
	import * as Avatar from '@epicenter/ui/avatar';
	import { Badge } from '@epicenter/ui/badge';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toastOnError } from '@epicenter/ui/sonner';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import UserIcon from '@lucide/svelte/icons/user';
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
	<DropdownMenu.Trigger
		aria-label="Account menu"
		class="flex min-w-0 items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<span class="max-w-48 truncate text-sm">{session.data?.user.email ?? (session.isError ? 'Account unavailable' : 'Loading account…')}</span>
		<Avatar.Root class="size-8">
			<Avatar.Fallback> <UserIcon class="size-4" /> </Avatar.Fallback>
		</Avatar.Root>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end" class="w-56">
		<DropdownMenu.Label class="font-normal">
			<div class="flex flex-col gap-1">
				<p class="break-all text-sm font-medium leading-none">{session.data?.user.email ?? 'Epicenter account'}</p>
				<div class="flex items-center gap-1.5 pt-1">
					{#if planName}
					<Badge variant="secondary" >
						{planName}
					</Badge>
					{/if}
					{#if isOnTrial}
						<Badge
							variant="outline"

						>
							Trial
						</Badge>
					{/if}
				</div>
			</div>
		</DropdownMenu.Label>

		<DropdownMenu.Separator />

		<DropdownMenu.Group>
			{#if session.isError}
				<DropdownMenu.Item disabled={session.isFetching} onclick={() => session.refetch()}>Retry account</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item onclick={toggleMode}>
				{#if isDark}
					<SunIcon class="mr-2 size-4" />
					Light mode
				{:else}
					<MoonIcon class="mr-2 size-4" />
					Dark mode
				{/if}
			</DropdownMenu.Item>
		</DropdownMenu.Group>

		<DropdownMenu.Separator />

		<DropdownMenu.Item onclick={signOut}>
			<LogOutIcon class="mr-2 size-4" />
			Sign out
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
