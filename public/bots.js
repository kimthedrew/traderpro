// SYMBOL_NAMES comes from symbols.js, loaded before this script.
const navLoginBtn = document.getElementById("nav-login-btn");
const loggedOut = document.getElementById("bots-logged-out");
const loggedIn = document.getElementById("bots-logged-in");
const botForm = document.getElementById("bot-form");
const botSymbolSelect = document.getElementById("bot-symbol");
const botDirectionSelect = document.getElementById("bot-direction");
const botStakeInput = document.getElementById("bot-stake");
const botNameInput = document.getElementById("bot-name");
const botCreateStatus = document.getElementById("bot-create-status");
const botsList = document.getElementById("bots-list");
const botsEmpty = document.getElementById("bots-empty");
const botsPendingCard = document.getElementById("bots-pending-card");
const botsPendingList = document.getElementById("bots-pending-list");
const botsPendingEmpty = document.getElementById("bots-pending-empty");

let currency = "";
let myLoginid = null;

Object.entries(SYMBOL_NAMES).forEach(([value, label]) => {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  botSymbolSelect.append(opt);
});

function directionLabel(direction) {
  if (direction === "up") return "Up only";
  if (direction === "down") return "Down only";
  return "Any direction";
}

function buildTradeItem(trade) {
  const el = document.createElement("div");
  el.className = "shadow-item";
  const time = new Date(trade.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const up = trade.direction === "up";
  el.innerHTML = `
    <span class="shadow-symbol">${up ? "▲" : "▼"} $${trade.stake.toFixed(2)}</span>
    <span class="shadow-leader-stake">@ ${trade.price.toFixed(2)} (${trade.signalChangePct.toFixed(2)}%)</span>
    <span class="shadow-time">${time}</span>
  `;
  return el;
}

async function buildBotCard(bot) {
  const el = document.createElement("div");
  el.className = "ct-card bot-card";
  el.innerHTML = `
    <div class="bot-card-header">
      <div>
        <h3>${bot.name}</h3>
        <p class="bot-card-meta">${SYMBOL_NAMES[bot.symbol] ?? bot.symbol} &middot; ${directionLabel(bot.direction)} &middot; $${bot.stake.toFixed(2)} stake</p>
      </div>
      <div class="bot-card-actions">
        <label class="ct-toggle bot-toggle">
          <input type="checkbox" class="bot-enabled-toggle" ${bot.enabled ? "checked" : ""} />
          <span>Enabled</span>
        </label>
        <button type="button" class="btn btn-outline bot-delete-btn">Delete</button>
      </div>
    </div>
    <div class="bot-trades"></div>
  `;

  el.querySelector(".bot-enabled-toggle").addEventListener("change", async (event) => {
    // Only send the field actually changing -- the backend does a partial
    // update now, so this can't clobber a stake edit made in another tab.
    await fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: event.target.checked }),
    });
  });

  el.querySelector(".bot-delete-btn").addEventListener("click", async () => {
    await fetch(`/api/bots/${bot.id}`, { method: "DELETE" });
    el.remove();
    botsEmpty.hidden = botsList.children.length > 0;
  });

  const tradesEl = el.querySelector(".bot-trades");
  const { trades } = await fetch(`/api/bots/${bot.id}/trades`).then((r) => r.json());
  if (!trades?.length) {
    tradesEl.innerHTML = `<p class="ct-status">No paper trades yet.</p>`;
  } else {
    trades.forEach((trade) => tradesEl.append(buildTradeItem(trade)));
  }

  return el;
}

async function loadBots() {
  const { bots } = await fetch("/api/bots").then((r) => r.json());
  botsList.innerHTML = "";
  botsEmpty.hidden = bots.length > 0;
  for (const bot of bots) {
    botsList.append(await buildBotCard(bot));
  }
}

// ---- Pending trade confirmations (Bot Builder active mode) ----
function buildPendingConfirmation(confirmation) {
  const el = document.createElement("div");
  el.className = "pending-confirmation";
  const up = confirmation.direction === "up";
  el.innerHTML = `
    <span class="pc-dir ${up ? "up" : "down"}">${up ? "▲" : "▼"}</span>
    <div class="pc-main">
      <div class="pc-bot">${confirmation.botName}</div>
      <div class="pc-meta">${SYMBOL_NAMES[confirmation.symbol] ?? confirmation.symbol} &middot; ${confirmation.stake.toFixed(2)} ${currency} &middot; Signal ${confirmation.signalChangePct.toFixed(2)}% @ ${confirmation.signalPrice.toFixed(2)}</div>
    </div>
    <div class="pc-actions">
      <button type="button" class="btn btn-outline btn-sm pc-reject">Reject</button>
      <button type="button" class="btn btn-warn btn-sm pc-confirm">Confirm — real money</button>
    </div>
  `;

  el.querySelector(".pc-reject").addEventListener("click", async () => {
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await fetch(`/api/bot-trading/confirmations/${confirmation.id}/reject`, { method: "POST" });
    el.remove();
    botsPendingEmpty.hidden = botsPendingList.children.length > 0;
  });

  el.querySelector(".pc-confirm").addEventListener("click", async () => {
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const res = await fetch(`/api/bot-trading/confirmations/${confirmation.id}/confirm`, { method: "POST" });
    if (res.ok) {
      el.remove();
      botsPendingEmpty.hidden = botsPendingList.children.length > 0;
    } else {
      el.querySelectorAll("button").forEach((b) => (b.disabled = false));
      el.querySelector(".pc-meta").textContent += " — couldn't place trade, try again.";
    }
  });

  return el;
}

function prependPendingConfirmation(confirmation) {
  botsPendingEmpty.hidden = true;
  botsPendingList.prepend(buildPendingConfirmation(confirmation));
}

async function loadPendingConfirmations() {
  const { confirmations } = await fetch("/api/bot-trading/pending").then((r) => r.json());
  botsPendingList.innerHTML = "";
  botsPendingEmpty.hidden = confirmations.length > 0;
  confirmations.forEach((c) => botsPendingList.append(buildPendingConfirmation(c)));
}

botForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  botCreateStatus.textContent = "Creating...";
  const res = await fetch("/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: botNameInput.value,
      symbol: botSymbolSelect.value,
      direction: botDirectionSelect.value,
      stake: Number(botStakeInput.value),
    }),
  });
  if (res.ok) {
    botForm.reset();
    botStakeInput.value = 10;
    botCreateStatus.textContent = "";
    loadBots();
  } else {
    botCreateStatus.textContent = "Couldn't create bot -- check your inputs.";
  }
});

initNavAuth([navLoginBtn]).then((session) => {
  if (session.loggedIn) navLoginBtn.textContent = session.loginid;
  loggedOut.hidden = session.loggedIn;
  loggedIn.hidden = !session.loggedIn;
  renderAccountBadge(document.getElementById("nav-account"), session);
  currency = session.currency ?? "";
  myLoginid = session.loggedIn ? session.loginid : null;
  if (session.loggedIn) {
    loadBots();
    loadPendingConfirmations();
  }
});

// Real Trading / Bot Builder active mode are feature-flagged server-side --
// this only shows/hides UI, the backend 404s the routes when they're off.
// See src/app.ts.
loadOAuthConfig().then((config) => {
  if (config.realTradingEnabled) document.getElementById("nav-trade-link").hidden = false;
  if (config.botTradingEnabled) {
    document.getElementById("bots-money-banner").hidden = false;
    document.getElementById("bots-pending-card").hidden = false;
    document.getElementById("bots-section-label").textContent = "Active — confirm each trade";
    document.getElementById("bots-sub").innerHTML =
      'Build a simple rule that watches Signals. <strong>A matching Signal queues a real trade</strong> that only places once you confirm it below — see the Terms of Service.';
    document.getElementById("bots-disclaimer-text").innerHTML =
      '<strong>Risk disclaimer.</strong> Deriv offers complex derivatives, such as options and contracts for difference ("CFDs"). These products may not be suitable for all clients, and trading them puts you at risk. You may lose some or all of the money you invest in a trade. Never trade with money you cannot afford to lose. <strong>Bots can place real trades on your account once you confirm them.</strong> This feature has not yet been reviewed by legal counsel — see the Terms of Service.';
  }
});

// Live confirmations, pushed the moment a bot's rule matches a Signal --
// reuses the same SSE stream /api/stream already carries ticks/signals
// over, but targeted server-side to this user's own connection only (see
// src/app.ts's broadcastToUser) -- unlike ticks/signals, this isn't public
// data. The ownerLoginid check below is defense in depth, not the real
// boundary; that's enforced server-side.
const botConfirmationStream = new EventSource("/api/stream");
botConfirmationStream.addEventListener("bot-confirmation-pending", (event) => {
  if (loggedIn.hidden) return; // not logged in (or session not resolved yet) -- nothing to show it in
  const confirmation = JSON.parse(event.data);
  if (confirmation.ownerLoginid !== myLoginid) return;
  prependPendingConfirmation(confirmation);
});
