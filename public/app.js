const SYMBOL_NAMES = {
  R_100: "Volatility 100",
  R_75: "Volatility 75",
  R_50: "Volatility 50",
  BOOM1000: "Boom 1000",
  CRASH500: "Crash 500",
  JD100: "Jump 100",
};

const track = document.getElementById("ticker-track");
const lastPrice = {}; // symbol -> last quote seen, for computing delta between ticks

function buildTickerItem(symbol) {
  const el = document.createElement("div");
  el.className = "ticker-item";
  el.dataset.symbol = symbol;
  el.innerHTML = `<span class="sym">${SYMBOL_NAMES[symbol] ?? symbol}</span><span class="px">&mdash;</span><span class="delta neutral">&mdash;</span>`;
  return el;
}

// Duplicate the row once so the CSS scroll animation (translateX -50%) loops seamlessly.
for (let rep = 0; rep < 2; rep++) {
  Object.keys(SYMBOL_NAMES).forEach((symbol) => track.appendChild(buildTickerItem(symbol)));
}

function updateTicker(symbol, quote) {
  const previous = lastPrice[symbol];
  lastPrice[symbol] = quote;

  const items = track.querySelectorAll(`[data-symbol="${symbol}"]`);
  items.forEach((item) => {
    item.querySelector(".px").textContent = quote.toFixed(2);
    const deltaEl = item.querySelector(".delta");
    if (previous === undefined) return; // first tick for this symbol: no delta yet
    const change = quote - previous;
    const changePct = (change / previous) * 100;
    const up = change >= 0;
    deltaEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(changePct).toFixed(2)}%`;
    deltaEl.className = `delta ${up ? "up" : "down"}`;
  });
}

// Live ticks, relayed by our backend from Deriv's WebSocket API.
const stream = new EventSource("/api/stream");
stream.addEventListener("tick", (event) => {
  const { symbol, quote } = JSON.parse(event.data);
  updateTicker(symbol, quote);
});

// OAuth2 + PKCE login. redirect.js exchanges the authorization code Deriv
// hands back for an httpOnly session cookie server-side -- the browser
// never sees the access token, so login state here comes from asking the
// backend, not reading storage.
const navLoginBtn = document.getElementById("nav-login-btn");
const navGetStartedBtn = document.getElementById("nav-get-started-btn");
const heroLoginBtn = document.getElementById("hero-login-btn");
const allAuthButtons = [navLoginBtn, navGetStartedBtn, heroLoginBtn];

let oauthConfig = null;
let loggedIn = false;

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

async function goToLogin() {
  if (!oauthConfig) return;
  const codeVerifier = randomPkceString(64);
  const codeChallenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const state = randomPkceString(32);

  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);

  const url = new URL(oauthConfig.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauthConfig.clientId);
  url.searchParams.set("redirect_uri", oauthConfig.redirectUri);
  url.searchParams.set("scope", oauthConfig.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}

async function logOut() {
  await fetch("/api/session", { method: "DELETE" });
  window.location.reload();
}

function applyAuthState() {
  allAuthButtons.forEach((btn) => {
    btn.removeEventListener("click", goToLogin);
    btn.removeEventListener("click", logOut);
    btn.addEventListener("click", loggedIn ? logOut : goToLogin);
  });
}

// If redirect.js bounced back with ?login_error=..., show what went wrong
// instead of silently landing on the logged-out homepage.
const LOGIN_ERROR_MESSAGES = {
  token_exchange: "Deriv rejected the login request while exchanging the authorization code.",
  account_fetch: "Logged in, but couldn't fetch your Deriv account.",
  state_mismatch: "Login could not be verified (state mismatch) -- please try again.",
  session_exchange: "Couldn't complete the login with our server.",
  network: "Network error while completing login.",
  unexpected: "Unexpected error completing login.",
  access_denied: "Login was cancelled.",
};

const loginErrorCode = new URLSearchParams(window.location.search).get("login_error");
if (loginErrorCode) {
  const banner = document.getElementById("login-error-banner");
  const text = document.getElementById("login-error-text");
  text.textContent = LOGIN_ERROR_MESSAGES[loginErrorCode] ?? `Login failed (${loginErrorCode}).`;
  banner.hidden = false;
  document.getElementById("login-error-dismiss").addEventListener("click", () => { banner.hidden = true; });
  const url = new URL(window.location.href);
  url.searchParams.delete("login_error");
  history.replaceState(null, "", url);
}

Promise.all([
  fetch("/api/config").then((r) => r.json()),
  fetch("/api/session").then((r) => r.json()),
]).then(([config, session]) => {
  oauthConfig = config;
  loggedIn = session.loggedIn;
  if (loggedIn) {
    navLoginBtn.textContent = session.loginid;
    navGetStartedBtn.textContent = "Log Out";
    heroLoginBtn.textContent = "Log Out";
  }
  applyAuthState();
});

// 3D tilt on the hero logo, following the cursor. Only on devices with a real
// mouse -- touch screens get the CSS-only float/glow animation instead.
const heroVisual = document.getElementById("hero-visual");
const heroLogo = document.getElementById("hero-logo");
const MAX_TILT_DEG = 12;

if (heroVisual && heroLogo && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  heroVisual.addEventListener("mousemove", (event) => {
    const rect = heroVisual.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    heroLogo.style.setProperty("--tilt-y", `${(px * MAX_TILT_DEG * 2).toFixed(2)}deg`);
    heroLogo.style.setProperty("--tilt-x", `${(-py * MAX_TILT_DEG * 2).toFixed(2)}deg`);
  });

  heroVisual.addEventListener("mouseleave", () => {
    heroLogo.style.setProperty("--tilt-x", "0deg");
    heroLogo.style.setProperty("--tilt-y", "0deg");
  });
}
