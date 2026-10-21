import { Type } from 'typebox';

/** Only authored draft text and recovery state live in Markdown. */
export const messagesTables = {
	drafts: Type.Object({
		chatId: Type.String(),
		profile: Type.String(),
		mode: Type.Union([Type.Literal('demo'), Type.Literal('live')]),
		state: Type.Union([
			Type.Literal('draft'),
			Type.Literal('sending'),
			Type.Literal('accepted'),
		]),
		pendingId: Type.String(),
	}),
};
