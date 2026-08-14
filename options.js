// Defaults live in the markup (checked / value / selected on each .field control),
// so there is no settings object to keep in sync here.
const FIELD_IDS = [...document.querySelectorAll(".field input, .field select")].map(
  (element) => element.id
);

function getElement(id) {
  return document.getElementById(id);
}

function setFieldValue(id, value) {
  if (value === undefined) {
    // Never saved — leave the markup default in place.
    return;
  }

  const element = getElement(id);

  if (element.type === "checkbox") {
    element.checked = Boolean(value);
    return;
  }

  element.value = value;
}

function getFieldValue(id) {
  const element = getElement(id);

  if (element.type === "checkbox") {
    return element.checked;
  }

  if (element.type === "number") {
    return Number(element.value);
  }

  return element.value;
}

function updateSameOriginWarning() {
  const matchMode = getElement("duplicateMatchMode").value;
  const warning = getElement("same-origin-warning");

  warning.classList.toggle("visible", matchMode === "sameOrigin");
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(FIELD_IDS);

  for (const id of FIELD_IDS) {
    setFieldValue(id, settings[id]);
  }

  updateSameOriginWarning();
}

async function saveSettings(event) {
  event.preventDefault();

  const settings = {};

  for (const id of FIELD_IDS) {
    settings[id] = getFieldValue(id);
  }

  if (settings.maxOpenTabs < 1) {
    settings.maxOpenTabs = 1;
  }

  await chrome.storage.sync.set(settings);

  const status = getElement("status");
  status.textContent = "Saved";

  setTimeout(() => {
    status.textContent = "";
  }, 1800);
}

// ── Domain rules ─────────────────────────────────────────────────────────────

let currentDomainRules = [];

async function loadDomainRules() {
  const { domainRules = [] } = await chrome.storage.sync.get({ domainRules: [] });
  currentDomainRules = domainRules;
  renderDomainRules();
}

async function saveDomainRules() {
  await chrome.storage.sync.set({ domainRules: currentDomainRules });
}

function renderDomainRules() {
  const list = getElement("domainList");
  list.replaceChildren();

  if (!currentDomainRules.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No domain exceptions added yet.";
    list.appendChild(p);
    return;
  }

  for (const domain of currentDomainRules) {
    const tag = document.createElement("span");
    tag.className = "domain-tag";

    const text = document.createElement("span");
    text.textContent = domain;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.title = "Remove";
    btn.addEventListener("click", async () => {
      currentDomainRules = currentDomainRules.filter((d) => d !== domain);
      await saveDomainRules();
      renderDomainRules();
    });

    tag.appendChild(text);
    tag.appendChild(btn);
    list.appendChild(tag);
  }
}

function normalizeDomain(input) {
  const trimmed = input.trim().toLowerCase();
  try {
    const withProtocol = trimmed.includes("://") ? trimmed : "https://" + trimmed;
    return new URL(withProtocol).hostname;
  } catch {
    return trimmed;
  }
}

async function addDomainRule() {
  const input = getElement("domainInput");
  const raw = input.value.trim();

  if (!raw) {
    return;
  }

  const domain = normalizeDomain(raw);

  if (!domain || currentDomainRules.includes(domain)) {
    input.value = "";
    return;
  }

  currentDomainRules = [...currentDomainRules, domain];
  await saveDomainRules();
  renderDomainRules();
  input.value = "";
}

// ── Closed tabs history ───────────────────────────────────────────────────────

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function loadHistory() {
  const { closedTabsHistory = [] } = await chrome.storage.local.get({ closedTabsHistory: [] });
  renderHistory(closedTabsHistory);
}

// The work happens in background.js so this page and the toolbar popup share one
// implementation. A stale session id is expected rather than exceptional, so the
// button relabels itself when the restore had to fall back.
async function reopenEntry(entry, button) {
  const result = await chrome.runtime.sendMessage({ type: "reopenClosedTab", entry });

  if (entry.sessionId && result && !result.restored) {
    button.textContent = "Reopen";
    button.title = "That session expired — opened the URL instead";
  }
}

function renderHistory(history) {
  const list = getElement("historyList");
  list.replaceChildren();

  if (!history.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No tabs have been closed by the extension yet.";
    list.appendChild(p);
    return;
  }

  for (const entry of history) {
    const item = document.createElement("div");
    item.className = "history-item";

    const favicon = document.createElement("img");
    favicon.className = "history-favicon";
    favicon.src = entry.favIconUrl || chrome.runtime.getURL("icons/icon16.png");
    favicon.onerror = () => {
      favicon.src = chrome.runtime.getURL("icons/icon16.png");
    };

    const info = document.createElement("div");
    info.className = "history-info";

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = entry.title;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${entry.url}  ·  ${timeAgo(entry.closedAt)}`;

    info.appendChild(title);
    info.appendChild(meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-reopen";
    // Labelled by what it can actually deliver: a session restore brings back
    // navigation history and scroll, a plain create only the URL.
    btn.textContent = entry.sessionId ? "Restore" : "Reopen";
    btn.title = entry.sessionId
      ? "Reopens with its back history and scroll position"
      : "Opens the URL again — history and scroll are gone";
    btn.addEventListener("click", () => reopenEntry(entry, btn));

    item.appendChild(favicon);
    item.appendChild(info);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const saveArea = getElement("save-area");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;

      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      getElement("panel-" + tab).classList.add("active");

      // Hidden wherever Save has nothing to write: history is read-only and
      // domain exceptions persist on add/remove, so the button would only look
      // like it did something.
      saveArea.style.display = tab === "history" || tab === "exceptions" ? "none" : "flex";

      if (tab === "history") {
        loadHistory();
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadDomainRules();
  loadHistory();
  initTabs();

  getElement("duplicateMatchMode").addEventListener("change", updateSameOriginWarning);

  getElement("btnAddDomain").addEventListener("click", addDomainRule);
  getElement("domainInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDomainRule();
    }
  });

  getElement("btnClearHistory").addEventListener("click", async () => {
    await chrome.storage.local.set({ closedTabsHistory: [] });
    renderHistory([]);
  });
});

document
  .getElementById("settings-form")
  .addEventListener("submit", saveSettings);
