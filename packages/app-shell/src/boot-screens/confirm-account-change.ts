import { isCallbackAuthClient, type AuthClient } from '@epicenter/auth';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';

// Desktop Home repeats this copy in apps/epicenter/src/ui/Settings.svelte.
/** One warning authorizes interruption when this account change completes. */
export function confirmAccountChange(auth: AuthClient): Promise<boolean> {
	return new Promise((resolve) => {
		confirmationDialog.open({
			title: 'Change account?',
			description: isCallbackAuthClient(auth)
				? 'Changing accounts will close this page. Active recordings and unsaved work will be discarded.'
				: 'Epicenter will restart when this account change completes. Active recordings and unsaved work, including work started while sign-in is pending, will be discarded.',
			confirm: { text: 'Continue', variant: 'destructive' },
			onConfirm: () => resolve(true),
			onCancel: () => resolve(false),
		});
	});
}
