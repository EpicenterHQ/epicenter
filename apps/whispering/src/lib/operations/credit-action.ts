import { type Account, createAccountManagementUrl } from '@epicenter/auth';
import type { AnyTaggedError } from 'wellcrafted/error';
import type { NoticeAction } from '$lib/report';

/** Keep the interrupted recording here while its account opens in the browser. */
export function creditAction(
	error: AnyTaggedError,
	account: Pick<Account, 'baseURL' | 'principalId'> | undefined,
): NoticeAction | undefined {
	if (error.name !== 'InsufficientCredits' || account === undefined)
		return undefined;
	const url = createAccountManagementUrl(account).href;
	return {
		label: 'Add credits',
		onClick: () => {
			window.open(url, '_blank', 'noopener');
		},
	};
}
