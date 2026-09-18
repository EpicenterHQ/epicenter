<script lang="ts">
	import { SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { resolve } from '$app/paths';
	import { authStartup } from '#platform/auth';
</script>

<SignInScreen
	startup={authStartup}
	appName="Honeycrisp"
	noun="notes"
	onCancel={() => location.replace(resolve('/local'))}
/>
