/**
 * What the account does for Vocab, in the learner's words, by where the
 * folder is. Over the learner's repository the account holds the words and
 * chats, so a signed-out page asks to sign in (`required`); over a folder on
 * this computer (`folder.reveal`) signing in is optional and only adds
 * Epicenter's hosted tutor models and dictation.
 */
import { folder } from './app.js';

export const accountPurpose =
	folder.reveal === null
		? {
				required: true,
				signedOut:
					'Sign in to use the words and chats in your Epicenter repository.',
				signedIn:
					"Your words and chats are in your Epicenter repository, vocab, where your other devices and Epicenter's desktop app reach them. Nothing is kept in this browser. This account also provides hosted tutor models and dictation.",
			}
		: {
				required: false,
				signedOut:
					"Your words and chats are Markdown files in Vocab's folder on this computer, with no sign-in. Signing in with Epicenter adds its hosted tutor models and dictation.",
				signedIn:
					"Your words and chats stay in Vocab's folder on this computer. This account provides Epicenter's hosted tutor models and dictation.",
			};
