// SYMBOL_NAMES comes from symbols.js, loaded before this script.
const navLoginBtn = document.getElementById("nav-login-btn");
const tradeUnavailable = document.getElementById("trade-unavailable");
const tradeAvailable = document.getElementById("trade-available");
const tradeLoggedOut = document.getElementById("trade-logged-out");
const tradeLoggedIn = document.getElementById("trade-logged-in");

const symbolSelect = document.getElementById("trade-symbol");
const currentPriceEl = document.getElementById("trade-current-price");
const chartCanvas = document.getElementById("trade-chart");
const chartEmpty = document.getElementById("trade-chart-empty");
const riseBtn = document.getElementById("trade-rise-btn");
const fallBtn = document.getElementById("trade-fall-btn");
const durationSelect = document.getElementById("trade-duration");
const stakeInput = document.getElementById("trade-stake");
const getPriceBtn = document.getElementById("trade-get-price-btn");
const proposalEl = document.getElementById("trade-proposal");
const proposalPayoutEl = document.getElementById("trade-proposal-payout");
const proposalPriceEl = document.getElementById("trade-proposal-price");
const confirmRow = document.getElementById("trade-confirm-row");
const confirmCheckbox = document.getElementById("trade-confirm-checkbox");
const buyBtn = document.getElementById("trade-buy-btn");
const statusEl = document.getElementById("trade-status");
const tradeList = document.getElementById("trade-list");
const tradeListEmpty = document.getElementById("trade-list-empty");

Object.entries(SYMBOL_NAMES).forEach(([value, label]) => {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  symbolSelect.append(opt);
});

let direction = null; // "rise" | "fall"
let currency = "";
let currentProposal = null; // { proposalId, askPrice, payout }

function clearProposal() {
  currentProposal = null;
  proposalEl.hidden = true;
  confirmRow.hidden = true;
  confirmCheckbox.checked = false;
  buyBtn.hidden = true;
  buyBtn.disabled = true;
  buyBtn.textContent = "Place trade";
}

function setDirection(next) {
  direction = next;
  riseBtn.classList.toggle("selected", next === "rise");
  fallBtn.classList.toggle("selected", next === "fall");
  clearProposal();
}

riseBtn.addEventListener("click", () => setDirection("rise"));
fallBtn.addEventListener("click", () => setDirection("fall"));
[durationSelect, stakeInput, symbolSelect].forEach((el) => el.addEventListener("change", clearProposal));

// ---- Live line chart, fed by the existing SSE tick stream (no new stream,
// no historical backfill -- reuses what app.js already uses for the
// homepage ticker). ----
const MAX_CHART_POINTS = 60;
let chartPoints = []; // { epoch, quote }

function drawChart() {
  const ctx = chartCanvas.getContext("2d");
  const w = chartCanvas.width;
  const h = chartCanvas.height;
  ctx.clearRect(0, 0, w, h);
  if (chartPoints.length < 2) return;

  const quotes = chartPoints.map((p) => p.quote);
  const min = Math.min(...quotes);
  const max = Math.max(...quotes);
  const range = max - min || 1;
  const pad = 10;

  ctx.beginPath();
  chartPoints.forEach((p, i) => {
    const x = pad + (i / (MAX_CHART_POINTS - 1)) * (w - pad * 2);
    const y = h - pad - ((p.quote - min) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const up = chartPoints[chartPoints.length - 1].quote >= chartPoints[0].quote;
  ctx.strokeStyle = up ? "#2fae66" : "#d6524a";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function resetChart() {
  chartPoints = [];
  chartEmpty.hidden = false;
  drawChart();
}

const stream = new EventSource("/api/stream");
stream.addEventListener("tick", (event) => {
  const { symbol, quote } = JSON.parse(event.data);
  if (symbol !== symbolSelect.value) return;
  chartEmpty.hidden = true;
  currentPriceEl.textContent = quote.toFixed(2);
  chartPoints.push({ quote, epoch: Date.now() });
  if (chartPoints.length > MAX_CHART_POINTS) chartPoints.shift();
  drawChart();
});

symbolSelect.addEventListener("change", () => {
  currentPriceEl.textContent = "";
  resetChart();
});

// ---- Proposal / buy ----
getPriceBtn.addEventListener("click", async () => {
  if (!direction) {
    statusEl.textContent = "Choose Rise or Fall first.";
    return;
  }
  statusEl.textContent = "Getting price...";
  clearProposal();
  const res = await fetch("/api/real-trading/proposal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: symbolSelect.value,
      direction,
      stake: Number(stakeInput.value),
      duration: Number(durationSelect.value),
    }),
  });
  if (!res.ok) {
    statusEl.textContent = "Couldn't get a price -- try again.";
    return;
  }
  currentProposal = await res.json();
  statusEl.textContent = "";
  proposalPayoutEl.textContent = `${currentProposal.payout.toFixed(2)} ${currency}`;
  proposalPriceEl.textContent = `${currentProposal.askPrice.toFixed(2)} ${currency}`;
  proposalEl.hidden = false;
  confirmRow.hidden = false;
  buyBtn.hidden = false;
  buyBtn.textContent = `Place trade — ${Number(stakeInput.value).toFixed(2)} ${currency}, real money`;
});

confirmCheckbox.addEventListener("change", () => {
  buyBtn.disabled = !confirmCheckbox.checked || !currentProposal;
});

buyBtn.addEventListener("click", async () => {
  if (!currentProposal || !direction) return;
  buyBtn.disabled = true;
  statusEl.textContent = "Placing trade...";
  const res = await fetch("/api/real-trading/buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: symbolSelect.value,
      direction,
      stake: Number(stakeInput.value),
      duration: Number(durationSelect.value),
      proposalId: currentProposal.proposalId,
      price: currentProposal.askPrice,
    }),
  });
  if (res.ok) {
    statusEl.textContent = "Trade placed.";
    clearProposal();
    loadTrades();
  } else {
    statusEl.textContent = "Couldn't place trade -- try again.";
    buyBtn.disabled = false;
  }
});

// ---- Recent trades ----
function buildTradeItem(trade) {
  const el = document.createElement("div");
  el.className = "trade-item";
  const rise = trade.direction === "rise";
  const time = new Date(trade.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  el.innerHTML = `
    <span class="trade-dir ${rise ? "rise" : "fall"}">${rise ? "▲" : "▼"}</span>
    <span class="trade-symbol">${SYMBOL_NAMES[trade.symbol] ?? trade.symbol} &middot; ${trade.stake.toFixed(2)} ${trade.currency}</span>
    <span class="trade-status ${trade.status}">${trade.status}</span>
    <span class="trade-time">${time}</span>
  `;
  return el;
}

async function loadTrades() {
  const { trades } = await fetch("/api/real-trading/trades").then((r) => r.json());
  tradeList.innerHTML = "";
  tradeListEmpty.hidden = trades.length > 0;
  trades.forEach((trade) => tradeList.append(buildTradeItem(trade)));
}

// ---- Boot ----
async function boot() {
  const config = await fetch("/api/config").then((r) => r.json());
  if (!config.realTradingEnabled) {
    tradeUnavailable.hidden = false;
    tradeAvailable.hidden = true;
    return;
  }

  if (typeof config.realTradingMaxStake === "number") {
    stakeInput.max = String(config.realTradingMaxStake);
    if (Number(stakeInput.value) > config.realTradingMaxStake) stakeInput.value = String(config.realTradingMaxStake);
    document.getElementById("trade-stake-cap").textContent = `(capped at ${config.realTradingMaxStake} while this is being tested)`;
  }

  const session = await initNavAuth([navLoginBtn]);
  if (session.loggedIn) navLoginBtn.textContent = session.loginid;
  tradeLoggedOut.hidden = session.loggedIn;
  tradeLoggedIn.hidden = !session.loggedIn;
  if (!session.loggedIn) return;

  currency = session.currency ?? "";
  resetChart();
  loadTrades();
}

boot();
