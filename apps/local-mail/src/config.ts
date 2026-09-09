/**
 * Local Mail's own configuration: Gmail's endpoints and its polling shape.
 *
 * There is no `dataDir` here any more, and no path, file, or environment read
 * that resolves one. Storage is `app.sqlite` and `app.secrets`;
 * where either of those lands is the runtime's business
 * and the application never learns it.
 *
 * The endpoint fields stay overridable because a test points the client at a
 * mock Gmail server. Unlike `apps/local-books`, Gmail's mirrored set is fixed
 * (messages and labels), so there is nothing to narrow and no entity list.
 */

export type MailConfig = {
	/** Gmail REST API origin. */
	apiBase: string;
	/** Google OAuth2 authorization endpoint. */
	authorizeUrl: string;
	/** Google OAuth2 token endpoint. */
	tokenUrl: string;
	/** `messages.list` and `history.list` page size; Gmail caps at 500. */
	pageSize: number;
};

export const GMAIL_API_BASE = 'https://gmail.googleapis.com';
export const GOOGLE_AUTHORIZE_URL =
	'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const DEFAULT_MAIL_CONFIG: MailConfig = {
	apiBase: GMAIL_API_BASE,
	authorizeUrl: GOOGLE_AUTHORIZE_URL,
	tokenUrl: GOOGLE_TOKEN_URL,
	pageSize: 100,
};

/**
 * The Google OAuth client this build authorizes through.
 *
 * Application-owned configuration, not an account secret: it identifies Local
 * Mail to Google and is the same for every account a person connects, while
 * `app.secrets` holds the per-account refresh token and nothing else
 * (ADR-0310). A packaged release compiles in its own identity; a source build
 * supplies one.
 *
 * The secret half is not a secret in the sense the name suggests. This is
 * Google's installed-application pattern, where the client secret ships inside
 * the application and PKCE is what actually protects the exchange.
 */
export type GmailClientIdentity = {
	clientId: string;
	clientSecret: string;
};
