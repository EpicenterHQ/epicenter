/** The self-hosted issuer's browser ceremony, shared by both runtime entries. */
export function signInPage() {
	return new Response(
		`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to your server</title>
<style>body{font:17px/1.5 system-ui,sans-serif;color:#202124;background:#fafafa;margin:0;padding:12vh 24px}main{max-width:420px;margin:auto}h1{font-size:30px;line-height:1.2}button{font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#252525;color:white;cursor:pointer}button:disabled{opacity:.55;cursor:wait}p{color:#555}#status{min-height:3em}a{color:inherit}</style>
<main><h1 id="title">Sign in to your server</h1><p id="detail">Use your passkey to continue.</p>
<button id="continue" type="button">Continue with a passkey</button><p id="status" role="status" aria-live="polite"></p>
<p id="existing" hidden>Already created your passkey? <a id="sign-in" href="/sign-in">Sign in</a>.</p>
<p>Need access or lost your passkey? Contact the person who runs this server.</p></main>
<script src="/auth/sign-in.js" defer></script></html>`,
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'referrer-policy': 'no-referrer',
				'content-security-policy':
					"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
			},
		},
	);
}
export function signInScript() {
	return new Response(
		String.raw`
const button = document.getElementById('continue');
const status = document.getElementById('status');
const params = new URL(location.href).searchParams;
const grant = new URLSearchParams(location.hash.slice(1)).get('enroll');
let signedIn = false;
if (grant) {
  history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('title').textContent = 'Set up your passkey';
  document.getElementById('detail').textContent = 'Create a passkey to access your server.';
  button.textContent = 'Create a passkey';
  document.getElementById('existing').hidden = false;
  document.getElementById('sign-in').href = location.pathname + location.search;
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
    if (response.status >= 500) throw new Error('The server is unavailable. Try again shortly.');
    throw new Error(grant && !signedIn ? 'This enrollment link may have expired or already been used. Ask the server operator for a new link.' : 'Sign-in could not be completed. Try again or contact the server operator.');
  }
  return response.json();
}
async function finish() {
  const callback = params.get('callback');
  const challenge = params.get('challenge');
  const state = params.get('state');
  if (!callback && !challenge && !state) {
    document.getElementById('title').textContent = 'You are signed in';
    document.getElementById('detail').hidden = true;
    status.textContent = 'Return to your app and connect to this server.';
    button.hidden = true;
    return;
  }
  if (!callback || !challenge || !state) throw new Error('This sign-in request is incomplete. Start again from your app.');
  const result = await post('/auth/session/authorize', { callback, challenge, state });
  location.assign(result.url);
}
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = signedIn ? 'Returning to your app…' : 'Waiting for your passkey…';
  try {
    if (signedIn) {
      await finish();
      return;
    }
    if (!window.PublicKeyCredential || !PublicKeyCredential.parseCreationOptionsFromJSON || !PublicKeyCredential.parseRequestOptionsFromJSON) throw new Error('Use a current browser that supports passkeys.');
    if (grant) {
      const ceremony = await post('/auth/passkey/registration-options', { token: grant });
      const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(ceremony.options) });
      if (!credential) throw new Error('No passkey was created. Try again.');
      await post('/auth/passkey/register', { id: ceremony.id, response: credential.toJSON() });
    } else {
      const ceremony = await post('/auth/passkey/authentication-options', {});
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(ceremony.options) });
      if (!credential) throw new Error('No passkey was selected. Try again.');
      await post('/auth/passkey/authenticate', { id: ceremony.id, response: credential.toJSON() });
    }
    signedIn = true;
    button.textContent = 'Continue';
    await finish();
  } catch (error) {
    status.textContent = error.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled. You can try again.' : error.message;
    button.disabled = false;
  }
});
// Reauthentication always asks for a fresh passkey proof. Other sign-ins may reuse the issuer cookie.
if (!grant && params.get('reauth') !== '1') {
  button.disabled = true;
  fetch('/auth/get-session', { credentials: 'same-origin' }).then(response => {
    if (!response.ok) throw new Error('The server is unavailable. Try again shortly.');
    return response.json();
  }).then(session => {
    if (!session) return;
    signedIn = true;
    button.textContent = 'Continue';
    return finish();
  }).catch(error => { status.textContent = error.message; }).finally(() => { button.disabled = false; });
}
`,
		{
			headers: {
				'content-type': 'text/javascript; charset=utf-8',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			},
		},
	);
}
