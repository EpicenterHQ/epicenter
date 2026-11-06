/**
 * How a reply and its latest send read to a person, and which replies a
 * send may select. The local program decides again on every send; this
 * only decides what the page offers.
 */
import type { BadgeVariant } from '@epicenter/ui/badge';
import type { Reply, Send } from '@epicenter/cli/messages-protocol';

/** A send that is not settled: it holds its reply, and while `claimed`, its chat. */
export const unsettled = (send: Send | undefined) =>
	send?.state === 'claimed' || send?.state === 'accepted';

/** A claimed send nobody is asking Beeper about any more: only a person can say what happened. */
export const needsCheck = (send: Send | undefined) =>
	send?.state === 'claimed' && !send.sending;

/** Whether `reply` can be selected to send with the accounts `profile` names. */
export const sendable = (reply: Reply, profile: string | null) =>
	profile !== null &&
	reply.status === 'ready' &&
	reply.profile === profile &&
	reply.body.trim() !== '' &&
	!unsettled(reply.send);

/** The badge for a send, by where it stands. */
export function sendBadge(send: Send): { label: string; variant: BadgeVariant } {
	switch (send.state) {
		case 'claimed':
			return send.sending
				? { label: 'Sending…', variant: 'secondary' }
				: { label: 'Check in Beeper', variant: 'destructive' };
		case 'accepted':
			return send.delivery === 'FAIL_RETRIABLE' || send.delivery === null
				? { label: 'Check in Beeper', variant: 'destructive' }
				: { label: 'Sent to Beeper', variant: 'secondary' };
		case 'sent':
			return { label: 'An earlier version was sent', variant: 'outline' };
		case 'failed':
			return { label: 'Not delivered', variant: 'destructive' };
		case 'not-sent':
			return { label: 'Not sent', variant: 'outline' };
	}
}

/** What a send's state means, in a sentence, when its badge is not enough. */
export function sendNote(send: Send) {
	if (send.note) return send.note;
	if (send.state === 'claimed' && !send.sending)
		return 'Messages recorded this send, but no answer from Beeper was recorded. Check the conversation in Beeper, then say what happened.';
	if (send.state === 'accepted')
		return 'Beeper has it and is delivering it. This reply leaves the folder once Beeper reports it sent.';
	return null;
}

/** A chat's name as the reply recorded it, or its id. */
export const chatName = (reply: { chatTitle?: string | null; chatId: string }) =>
	reply.chatTitle || reply.chatId;
