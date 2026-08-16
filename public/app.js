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

// OAuth login. redirect.html stores the account/token pair it receives
// back from Deriv into localStorage before bouncing here.
const navLoginBtn = document.getElementById("nav-login-btn");
const navGetStartedBtn = document.getElementById("nav-get-started-btn");
const heroLoginBtn = document.getElementById("hero-login-btn");

fetch("/api/config")
  .then((r) => r.json())
  .then(({ oauthUrl }) => {
    [navLoginBtn, navGetStartedBtn, heroLoginBtn].forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.href = oauthUrl;
      });
    });
  });

const storedAccount = localStorage.getItem("deriv_account");
const storedToken = localStorage.getItem("deriv_token");
if (storedAccount && storedToken) {
  navLoginBtn.textContent = storedAccount;
  navGetStartedBtn.textContent = "Reconnect";
  heroLoginBtn.textContent = "Reconnect Deriv Account";
}
