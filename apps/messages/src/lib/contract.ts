/**
 * Messages' contract: one Markdown note per outgoing reply,
 * `replies/{id}.md`, in the Messages folder on this computer. It is defined
 * beside the send owner (`@epicenter/cli/messages-contract`), which the
 * local program and `epicenter messages` share.
 *
 * Published, unchanged, as `static/contract.json` (`bun run contract`), so
 * `epicenter check <url>/contract.json ~/Epicenter/Messages` checks the
 * folder.
 */
export {
	type MessagesContract as Messages,
	messagesContract as messages,
} from '@epicenter/cli/messages-contract';
