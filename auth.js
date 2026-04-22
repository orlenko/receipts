// receipts — provider auth.
// Two ways to get a working API key into the page:
//
//   1. Direct OpenAI: user pastes their own sk-... key. Stays in localStorage,
//      sent only to api.openai.com. (Existing flow — handled in app.js.)
//
//   2. Sign in with OpenRouter via PKCE OAuth: redirect to openrouter.ai,
//      user authorizes, redirected back with ?code, page exchanges the code
//      for a long-lived API key, stores it. From then on the key is used
//      against openrouter.ai (OpenAI-compatible API in front of many models).
//
// All three steps of the OpenRouter PKCE flow happen in this module:
//   beginOpenRouterAuth()  -> generates verifier, redirects to OpenRouter
//   completeOpenRouterAuth() -> reads ?code, exchanges, returns the key
//   isReturningFromOpenRouter() -> page-load helper to detect the redirect

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const VERIFIER_STORAGE = 'receipts.or_verifier';

// ---------- PKCE helpers ----------
function randomVerifier(length = 64) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  // base64url, no padding
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFromVerifier(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function callbackUrl() {
  // OpenRouter requires https on 443 or port 3000. Strip any existing query/hash
  // so the redirect lands clean and we can detect ?code= on return.
  return window.location.origin + window.location.pathname;
}

// ---------- public API ----------

// Kicks off the redirect. Caller never returns to its own code; the browser
// navigates away and lands back on the same page with ?code=... in the URL.
export async function beginOpenRouterAuth() {
  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER_STORAGE, verifier);
  const challenge = await challengeFromVerifier(verifier);
  const params = new URLSearchParams({
    callback_url: callbackUrl(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

export function isReturningFromOpenRouter() {
  return new URLSearchParams(window.location.search).has('code');
}

// Exchanges the ?code= for a long-lived API key. Cleans the URL and the
// verifier on success or failure. Returns { key } on success, throws on error.
export async function completeOpenRouterAuth() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) throw new Error('No authorization code in URL');

  const verifier = sessionStorage.getItem(VERIFIER_STORAGE);
  sessionStorage.removeItem(VERIFIER_STORAGE);

  // Always clean the URL, even if the exchange below fails — we don't want a
  // stale ?code= lying around in history.
  history.replaceState({}, '', callbackUrl());

  if (!verifier) {
    throw new Error('No PKCE verifier in session storage — was the flow started in this tab?');
  }

  const resp = await fetch(OPENROUTER_KEYS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter key exchange failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data?.key) throw new Error('OpenRouter response missing key');
  return { key: data.key };
}
