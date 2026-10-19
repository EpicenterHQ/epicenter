/** The rows of Epicenter's local AI connections folder. */
import { Type } from 'typebox';

/** The shell's scope for its own connection files. */
export const CONNECTIONS_FOLDER_ID = 'so.epicenter';

/** Keychain endpoints and keys stay outside these Markdown rows. */
export const connectionsTables = {
	connections: Type.Object({
		kind: Type.Union([
			Type.Literal('openai-compatible'),
			Type.Literal('epicenter'),
			Type.Literal('local'),
		]),
		title: Type.String(),
		model: Type.String(),
	}),
};
