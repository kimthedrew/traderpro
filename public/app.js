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

// OAuth login. redirect.html exchanges the token Deriv hands back for an
// httpOnly session cookie server-side -- the browser never sees it, so
// login state here comes from asking the backend, not reading storage.
const navLoginBtn = document.getElementById("nav-login-btn");
const navGetStartedBtn = document.getElementById("nav-get-started-btn");
const heroLoginBtn = document.getElementById("hero-login-btn");
const allAuthButtons = [navLoginBtn, navGetStartedBtn, heroLoginBtn];

let oauthUrl = null;
let loggedIn = false;

function goToLogin() {
  if (oauthUrl) window.location.href = oauthUrl;
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

Promise.all([
  fetch("/api/config").then((r) => r.json()),
  fetch("/api/session").then((r) => r.json()),
]).then(([config, session]) => {
  oauthUrl = config.oauthUrl;
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
