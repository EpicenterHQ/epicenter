<script lang="ts">
	import * as Avatar from '@epicenter/ui/avatar';
	import { Badge } from '@epicenter/ui/badge';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { toastOnError } from '@epicenter/ui/sonner';
	import CreditCardIcon from '@lucide/svelte/icons/credit-card';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import UserIcon from '@lucide/svelte/icons/user';
	import { createQuery } from '@tanstack/svelte-query';
	import { mode, toggleMode } from 'mode-watcher';
	import { goto } from '$app/navigation';
	import { getDashboard } from '$lib/dashboard/context';
	import { auth } from '$lib/platform/auth';

	const { billing, billingApi, signal } = getDashboard();
	const overview = createQuery(() => billing.overview.options);

	const planName = $derived(overview.data?.planDisplayName ?? 'Free');
	const isOnTrial = $derived(overview.data?.trial != null);

	async function openBillingPortal() {
		const { data, error } = await billingApi.portal();
		if (signal.aborted) return;
		if (error) return toastOnError(error, 'Could not open billing portal');
		if (data.portalUrl) window.location.href = data.portalUrl;
	}

	async function signOut() {
		const result = await auth.signOut();
		if (result.error) toastOnError(result, 'Failed to sign out');
	}

	const isDark = $derived(mode.current === 'dark');
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<Avatar.Root class="size-8">
			<Avatar.Fallback> <UserIcon class="size-4" /> </Avatar.Fallback>
		</Avatar.Root>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end" class="w-56">
		<DropdownMenu.Label class="font-normal">
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium leading-none">Epicenter account</p>
				<div class="flex items-center gap-1.5 pt-1">
					<Badge variant="secondary" class="text-[10px] px-1.5 py-0">
						{planName}
					</Badge>
					{#if isOnTrial}
						<Badge
							variant="outline"
							class="text-[10px] px-1.5 py-0 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
						>
							Trial
						</Badge>
					{/if}
				</div>
			</div>
		</DropdownMenu.Label>

		<DropdownMenu.Separator />

		<DropdownMenu.Group>
			<DropdownMenu.Item onclick={() => goto('/dashboard/account')}>
				<UserIcon class="mr-2 size-4" />
				Account
			</DropdownMenu.Item>
			<DropdownMenu.Item onclick={openBillingPortal}>
				<CreditCardIcon class="mr-2 size-4" />
				Manage billing
			</DropdownMenu.Item>
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
