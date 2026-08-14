async function init() {
  const { pendingClosure } = await chrome.storage.session.get("pendingClosure");

  if (!pendingClosure) {
    window.close();
    return;
  }

  const { tabIdsToClose, allTabs, excessCount, newTabId, strategy, maxOpenTabs } = pendingClosure;
  const collapsedGroupCount = pendingClosure.collapsedGroupCount || 0;

  // Without this the arithmetic looks broken: the limit counts what the tab strip
  // shows, so a collapsed group is one item and its tabs are not in the list.
  const groupNote = collapsedGroupCount
    ? ` ${collapsedGroupCount} collapsed tab group${collapsedGroupCount !== 1 ? "s" : ""} count as one each and cannot be closed here.`
    : "";

  const subtitle = document.getElementById("subtitle");
  const tabList = document.getElementById("tab-list");
  const newTabMsg = document.getElementById("new-tab-msg");
  const selectionHint = document.getElementById("selection-hint");
  const btnConfirm = document.getElementById("btn-confirm");
  const btnCancel = document.getElementById("btn-cancel");
  const limitInput = document.getElementById("new-limit");

  // Wired before the strategy branch so both the pick-tabs and the
  // close-new-tab variants offer the same escape hatch. The minimum is the UNIT
  // count the limit is compared against -- not allTabs.length, which counts only
  // the closable tabs and would let you raise the limit to a number you are still
  // over, reopening this window at once.
  const minimumLimit = pendingClosure.unitCount || allTabs.length;
  limitInput.min = minimumLimit;
  limitInput.value = minimumLimit;

  async function raiseLimit(scope) {
    const limit = Number(limitInput.value);

    if (!Number.isInteger(limit) || limit < minimumLimit) {
      selectionHint.textContent = `Enter ${minimumLimit} or more — that is what currently counts toward the limit.`;
      return;
    }

    await chrome.runtime.sendMessage({ type: "raiseLimit", maxOpenTabs: limit, scope });
    window.close();
  }

  document.getElementById("btn-raise-session").addEventListener("click", () => raiseLimit("session"));
  document.getElementById("btn-raise-always").addEventListener("click", () => raiseLimit("always"));

  if (strategy === "closeNewTab") {
    tabList.style.display = "none";
    newTabMsg.style.display = "block";
    newTabMsg.textContent =
      `You have reached the limit of ${maxOpenTabs} tabs. ` +
      "The tab you just opened will be closed.";
    subtitle.textContent = `Your tab limit is ${maxOpenTabs}.` + groupNote;
    btnConfirm.textContent = "Close new tab";
    btnCancel.style.display = "none";

    btnConfirm.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "confirmClose" });
      window.close();
    });

    return;
  }

  subtitle.textContent =
    `You have reached the limit of ${maxOpenTabs} tabs.` + groupNote +
    ` Select which tabs to close (at least ${excessCount}):`;

  const checkedIds = new Set(tabIdsToClose);

  function updateUI() {
    const count = checkedIds.size;
    btnConfirm.textContent = `Close ${count} tab${count !== 1 ? "s" : ""}`;
    btnConfirm.disabled = count < excessCount;
    selectionHint.textContent =
      count < excessCount
        ? `Select at least ${excessCount - count} more tab${excessCount - count !== 1 ? "s" : ""}`
        : "";
  }

  for (const tab of allTabs) {
    const item = document.createElement("label");
    item.className = "tab-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tab-checkbox";
    checkbox.checked = checkedIds.has(tab.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        checkedIds.add(tab.id);
      } else {
        checkedIds.delete(tab.id);
      }
      updateUI();
    });

    const favicon = document.createElement("img");
    favicon.className = "tab-favicon";
    favicon.src = tab.favIconUrl || chrome.runtime.getURL("icons/icon16.png");
    favicon.onerror = () => {
      favicon.src = chrome.runtime.getURL("icons/icon16.png");
    };

    const info = document.createElement("div");
    info.className = "tab-info";

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url;

    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = tab.url;

    info.appendChild(title);
    info.appendChild(url);
    item.appendChild(checkbox);
    item.appendChild(favicon);
    item.appendChild(info);

    if (tab.isNew) {
      const badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.textContent = "new";
      item.appendChild(badge);
    }

    tabList.appendChild(item);
  }

  updateUI();

  btnConfirm.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "confirmClose",
      tabIds: Array.from(checkedIds)
    });
    window.close();
  });

  btnCancel.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "closeNewTab" });
    window.close();
  });
}

document.addEventListener("DOMContentLoaded", init);
