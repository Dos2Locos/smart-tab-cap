async function init() {
  const { duplicateNotice } = await chrome.storage.session.get("duplicateNotice");

  if (!duplicateNotice) {
    window.close();
    return;
  }

  const { closedTitle, closedUrl } = duplicateNotice;

  // The kept tab's title is deliberately not shown: it is whatever page you are
  // now looking at, and interpolating it made this subtitle wrap to three lines
  // and squeeze the box below out of a 260px popup.
  document.getElementById("subtitle").textContent =
    "You already had this page open, so we switched you to it and closed:";
  document.getElementById("closed-title").textContent = closedTitle;
  document.getElementById("closed-url").textContent = closedUrl;

  // No timeout, no dismiss-on-blur -- only this click clears it.
  document.getElementById("btn-dismiss").addEventListener("click", async () => {
    await chrome.storage.session.remove("duplicateNotice");
    window.close();
  });
}

document.addEventListener("DOMContentLoaded", init);
