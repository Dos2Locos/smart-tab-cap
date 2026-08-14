const HISTORY_SHOWN = 6;

function getElement(id) {
  return document.getElementById(id);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

// ── Count ────────────────────────────────────────────────────────────────────

async function loadStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await chrome.runtime.sendMessage({
    type: "getStatus",
    windowId: tab?.windowId
  });

  if (!status) {
    return;
  }

  const limit = status.sessionOverride || status.maxOpenTabs;

  getElement("units").textContent = status.units;
  getElement("of").textContent = status.enableTabLimit ? ` / ${limit}` : " open";
  getElement("scope").textContent = status.enableTabLimit
    ? status.applyLimitPerWindow
      ? "in this window"
      : "across all windows"
    : "limit is off";

  const bar = getElement("bar");
  bar.style.width = status.enableTabLimit
    ? `${Math.min(100, Math.round((status.units / limit) * 100))}%`
    : "0%";
  bar.className = "bar-fill";
  if (status.enableTabLimit && status.units >= limit) {
    bar.classList.add("over");
  } else if (status.enableTabLimit && status.units >= limit - 2) {
    bar.classList.add("near");
  }

  // Two things the count alone would misrepresent: a collapsed group looks like
  // one tab, and a session-only raise makes the effective limit differ from the
  // one saved in settings.
  const notes = [];
  if (status.collapsedGroups) {
    notes.push(
      `${status.collapsedGroups} collapsed group${status.collapsedGroups !== 1 ? "s" : ""} count as one each.`
    );
  }
  if (status.sessionOverride) {
    notes.push(
      `Limit raised to ${status.sessionOverride} for this session only — it returns to ${status.maxOpenTabs} when Chrome restarts.`
    );
  }

  const note = getElement("note");
  note.textContent = notes.join(" ");
  note.classList.toggle("hidden", notes.length === 0);

  const input = getElement("new-limit");
  input.min = Math.max(1, status.units);
  input.value = Math.max(status.units, limit) + 5;
}

// ── Raise the limit ──────────────────────────────────────────────────────────

async function raiseLimit(scope) {
  const input = getElement("new-limit");
  const limit = Number(input.value);

  if (!Number.isInteger(limit) || limit < Number(input.min)) {
    input.value = input.min;
    return;
  }

  await chrome.runtime.sendMessage({ type: "raiseLimit", maxOpenTabs: limit, scope });
  await loadStatus();
}

// ── Closed-tab history ───────────────────────────────────────────────────────

async function loadHistory() {
  const { closedTabsHistory = [] } = await chrome.storage.local.get({ closedTabsHistory: [] });
  const list = getElement("history");
  list.replaceChildren();

  getElement("history-empty").style.display = closedTabsHistory.length ? "none" : "block";

  for (const entry of closedTabsHistory.slice(0, HISTORY_SHOWN)) {
    const item = document.createElement("div");
    item.className = "history-item";

    const favicon = document.createElement("img");
    favicon.src = entry.favIconUrl || chrome.runtime.getURL("icons/icon16.png");
    favicon.onerror = () => {
      favicon.src = chrome.runtime.getURL("icons/icon16.png");
    };

    const text = document.createElement("div");
    text.className = "history-text";

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = entry.title || entry.url;

    const host = document.createElement("div");
    host.className = "history-when";
    host.textContent = hostOf(entry.url);

    text.appendChild(title);
    text.appendChild(host);

    const button = document.createElement("button");
    button.type = "button";
    // Labelled by what it can deliver: a session restore brings back back-history
    // and scroll, a plain create only the URL.
    button.textContent = entry.sessionId ? "Restore" : "Reopen";
    button.title = entry.sessionId
      ? "Reopens with its back history and scroll position"
      : "Opens the URL again — history and scroll are gone";
    button.addEventListener("click", async () => {
      const result = await chrome.runtime.sendMessage({ type: "reopenClosedTab", entry });

      if (entry.sessionId && result && !result.restored) {
        button.textContent = "Reopen";
        button.title = "That session expired — opened the URL instead";
        return;
      }

      window.close();
    });

    item.appendChild(favicon);
    item.appendChild(text);
    item.appendChild(button);
    list.appendChild(item);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadHistory();

  getElement("raise-session").addEventListener("click", () => raiseLimit("session"));
  getElement("raise-always").addEventListener("click", () => raiseLimit("always"));

  getElement("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  getElement("close-dupes").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "sweepDuplicatesNow" });
    await loadStatus();
    await loadHistory();
  });
});
