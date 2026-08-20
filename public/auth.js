// Shared OAuth2 + PKCE login/logout -- used by both the homepage and any
// other page that needs to know/change login state (e.g. bots.html).
// Kept in one place deliberately: this is security-sensitive code, and two
// copies drifting apart is exactly how that kind of bug happens.

// PKCE (Proof Key for Code Exchange): a random verifier + its SHA-256 hash,
// generated fresh per login attempt. Deriv checks the hash matches when the
// backend exchanges the code, so an intercepted code alone is useless.
function randomPkceString(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let cachedOauthConfig = null;

async function loadOAuthConfig() {
  if (!cachedOauthConfig) cachedOauthConfig = await fetch("/api/config").then((r) => r.json());
  return cachedOauthConfig;
}

async function goToDerivLogin() {
  const config = await loadOAuthConfig();
  const codeVerifier = randomPkceString(64);
  const codeChallenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const state = randomPkceString(32);

  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);

  const url = new URL(config.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}

async function logOutOfDeriv() {
  await fetch("/api/session", { method: "DELETE" });
  window.location.reload();
}

// Wires a page's nav auth buttons to login-when-logged-out /
// logout-when-logged-in, and returns the current session so the caller can
// set button text and adjust the rest of the page (e.g. show/hide a
// feature that needs login) however makes sense for that page.
async function initNavAuth(buttons) {
  const session = await fetch("/api/session").then((r) => r.json());
  const handler = session.loggedIn ? logOutOfDeriv : goToDerivLogin;
  buttons.forEach((btn) => btn && btn.addEventListener("click", handler));
  return session;
}
