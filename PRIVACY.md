# Privacy Policy — Smart Tab Cap

Last updated: 14 August 2026

Smart Tab Cap sends nothing anywhere. It has no server, no account, no analytics,
and makes no network requests of its own. Everything below happens inside your own
copy of Chrome.

This document is deliberately specific rather than reassuring, so you can check it
against the source code — all of which is in this repository.

## What the extension reads

To do its job the extension reads, at the moment it needs them:

- **The URL and title of your open tabs.** Comparing URLs is the only way to tell
  that a tab you just opened duplicates one you already had. Counting tabs is the
  only way to know the limit has been reached.
- **Which tabs are pinned, playing audio, or in a collapsed tab group.** These
  decide whether a tab counts toward the limit and whether it may be closed.

This data is used in memory, for that decision, and then discarded. It is not
logged, accumulated, or sent anywhere.

## What the extension stores, and where

| What | Where | Leaves your device? |
|---|---|---|
| Your settings — tab limit, matching mode, and the domain exceptions you type | `chrome.storage.sync` | Only through **Chrome's own sync**, to your own Google account, if you have Chrome Sync enabled. Never to us. |
| Recently closed tabs: URL, title, favicon URL, timestamp, and Chrome's session id — capped at the 50 most recent | `chrome.storage.local` | No. This never leaves the device. |
| Transient state: the pending tab-closure decision and the duplicate notice | `chrome.storage.session` | No. Cleared when Chrome closes. |

The closed-tab list is the only lasting record of your browsing the extension keeps,
and it exists for one reason: so that a tab the extension closed can be reopened
with its navigation history and scroll position intact. You can clear it at any time
from the extension's options page, under **History**.

## The one thing that does touch the network

The options page and the toolbar popup show each closed tab's favicon using the
favicon URL Chrome already had for that page. Your browser fetches that image from
the website's own server, exactly as it did when the tab was open. Nothing is sent
to us or to any third party, and no favicon is fetched for a site you have not
visited. If the image fails to load, the extension's own icon is shown instead.

## What the extension never does

- No data of any kind is transmitted to the developer or to any third party.
- No analytics, telemetry, crash reporting, advertising, or tracking identifiers.
- No selling or transferring of user data to anyone, including advertising
  platforms, data brokers, or information resellers.
- No use or transfer of user data for personalised advertising.
- No use or transfer of user data to determine credit-worthiness or for lending.
- No remotely hosted code. The extension runs only the JavaScript shipped inside
  it, which Manifest V3 requires and which you can read in this repository.

Use of any information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Why each permission is requested

| Permission | Why it is needed |
|---|---|
| `tabs` | To read tab URLs and titles in order to detect duplicates, to count tabs against the limit, and to close the ones you choose. This is the extension's core function; it cannot work without it. |
| `tabGroups` | To read whether a tab group is collapsed. A collapsed group counts as one entry in the tab strip, so the limit counts it as one. `tab.groupId` alone cannot tell collapsed from expanded. |
| `sessions` | To reopen a closed tab with its navigation history and scroll position rather than merely reloading its URL. |
| `storage` | To save your settings and the recently-closed list described above. |

The extension requests no host permissions and no access to page content. It cannot
read, modify, or inject anything into the pages you visit.

## Deleting your data

- **The closed-tab list:** options page → **History** → clear.
- **Everything:** uninstall the extension. That removes its stored data from your
  device. Settings you had synced are held by Chrome Sync rather than by the
  extension, so if you want to be certain they are gone, clear the closed-tab list
  and reset your settings before uninstalling.

## Changes

Any change to this policy will be committed to this repository, so its full history
is public and auditable.

## Contact

Questions about this policy: cegomez@gmail.com
