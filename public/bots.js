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
  if (session.loggedIn) loadBots();
});
