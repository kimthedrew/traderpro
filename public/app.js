// SYMBOL_NAMES comes from symbols.js, loaded before this script.
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

// Live signals: server-detected price-move alerts, delivered over the same
// SSE connection as ticks (no login/account required to watch).
const MAX_SIGNALS_SHOWN = 20;
const signalsList = document.getElementById("signals-list");
const signalsEmpty = document.getElementById("signals-empty");

function formatSignalTime(isoOrEpochMs) {
  return new Date(isoOrEpochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function buildSignalItem(signal, timeSource) {
  const el = document.createElement("div");
  el.className = "signal-item";
  const up = signal.direction === "up";
  const changePct = signal.changePct ?? signal.change_pct;
  el.innerHTML = `
    <span class="signal-dir ${up ? "up" : "down"}">${up ? "▲" : "▼"}</span>
    <span class="signal-symbol">${SYMBOL_NAMES[signal.symbol] ?? signal.symbol}</span>
    <span class="signal-change ${up ? "up" : "down"}">${up ? "+" : ""}${changePct.toFixed(2)}%</span>
    <span class="signal-price">${signal.price.toFixed(2)}</span>
    <span class="signal-time">${formatSignalTime(timeSource)}</span>
  `;
  return el;
}

// The initial history fetch and the already-open SSE listener race: a
// signal firing in that window can arrive via both paths. Dedup by a
// content key (a symbol has a 10min cooldown, so two real signals with
// identical symbol/direction/changePct/price in that span is not a
// realistic collision) rather than plumbing a DB id through the
// broadcast-before-insert live path.
const seenSignalKeys = new Set();
function signalKey(signal) {
  return `${signal.symbol}|${signal.direction}|${signal.changePct}|${signal.price}`;
}

function prependSignal(signal, timeSource) {
  const key = signalKey(signal);
  if (seenSignalKeys.has(key)) return;
  seenSignalKeys.add(key);
  signalsEmpty.remove();
  signalsList.prepend(buildSignalItem(signal, timeSource));
  while (signalsList.children.length > MAX_SIGNALS_SHOWN) {
    signalsList.lastElementChild.remove();
  }
}

fetch("/api/signals")
  .then((r) => r.json())
  .then(({ signals }) => {
    if (!signals?.length) return;
    signalsEmpty.remove();
    signals.forEach((signal) => {
      seenSignalKeys.add(signalKey(signal));
      signalsList.append(buildSignalItem(signal, signal.createdAt));
    });
  });

stream.addEventListener("signal", (event) => {
  prependSignal(JSON.parse(event.data), Date.now());
});

// OAuth2 + PKCE login (implementation shared with other pages via auth.js).
// redirect.js exchanges the authorization code Deriv hands back for an
// httpOnly session cookie server-side -- the browser never sees the access
// token, so login state here comes from asking the backend, not storage.
const navLoginBtn = document.getElementById("nav-login-btn");
const navGetStartedBtn = document.getElementById("nav-get-started-btn");
const heroLoginBtn = document.getElementById("hero-login-btn");

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

initNavAuth([navLoginBtn, navGetStartedBtn, heroLoginBtn]).then((session) => {
  if (session.loggedIn) {
    navLoginBtn.textContent = session.loginid;
    navGetStartedBtn.textContent = "Log Out";
    heroLoginBtn.textContent = "Log Out";
  }
});

// Copy Trading (shadow mode): shows a follower's own settings + what would
// have been copied, without ever placing a real trade.
const ctLoggedOut = document.getElementById("ct-logged-out");
const ctLoggedIn = document.getElementById("ct-logged-in");
const ctForm = document.getElementById("ct-form");
const ctEnabled = document.getElementById("ct-enabled");
const ctStakeRatio = document.getElementById("ct-stake-ratio");
const ctMaxStake = document.getElementById("ct-max-stake");
const ctSaveStatus = document.getElementById("ct-save-status");
const ctShadowList = document.getElementById("ct-shadow-list");
const ctShadowEmpty = document.getElementById("ct-shadow-empty");

function buildShadowItem(entry) {
  const el = document.createElement("div");
  el.className = "shadow-item";
  const time = new Date(entry.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  el.innerHTML = `
    <span class="shadow-symbol">${SYMBOL_NAMES[entry.symbol] ?? entry.symbol}</span>
    <span class="shadow-leader-stake">leader: $${entry.leaderStake.toFixed(2)}</span>
    <span class="shadow-stake">you: $${entry.wouldBeStake.toFixed(2)}</span>
    <span class="shadow-time">${time}</span>
  `;
  return el;
}

async function loadShadowLog() {
  const { entries } = await fetch("/api/copy-trading/shadow-log").then((r) => r.json());
  if (!entries?.length) return;
  ctShadowEmpty.remove();
  entries.forEach((entry) => ctShadowList.append(buildShadowItem(entry)));
}

async function loadCopyTradingStatus() {
  const status = await fetch("/api/copy-trading/status").then((r) => r.json());
  ctLoggedOut.hidden = status.loggedIn;
  ctLoggedIn.hidden = !status.loggedIn;
  if (!status.loggedIn) return;

  ctEnabled.checked = status.enabled;
  ctStakeRatio.value = status.stakeRatio;
  ctMaxStake.value = status.maxStake ?? "";
  loadShadowLog();
}

ctForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  ctSaveStatus.textContent = "Saving...";
  const maxStakeRaw = ctMaxStake.value.trim();
  const res = await fetch("/api/copy-trading/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: ctEnabled.checked,
      stakeRatio: Number(ctStakeRatio.value),
      maxStake: maxStakeRaw === "" ? null : Number(maxStakeRaw),
    }),
  });
  ctSaveStatus.textContent = res.ok ? "Saved." : "Couldn't save your settings -- try again.";
});

loadCopyTradingStatus();

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
