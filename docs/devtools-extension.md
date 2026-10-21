# QuorumProof DevTools Extension

The QuorumProof DevTools extension adds a **QuorumProof** panel to Chrome DevTools. It records
the Soroban RPC calls the page makes (simulations, submissions, transaction lookups, event
queries) and shows their status, timing and key results, so you can debug contract
interactions without reading raw network logs.

Source: [`tools/devtools-extension/`](../tools/devtools-extension/). Tracking issue: #1674.

> **Status: skeleton (v0.1.0).** It supports inspection of contract and transaction calls.
> Decoding XDR payloads and building the extension for the Chrome Web Store are not done yet.

## Installing (load unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `tools/devtools-extension/` directory.
3. Open QuorumProof in a tab, then open DevTools (`F12` / `Cmd+Option+I`).
4. Select the **QuorumProof** tab. If you don't see it, reopen DevTools after loading.

Recording starts when the panel is open. Calls made before DevTools was opened are not
captured, so reload the page after opening the panel to record its startup calls.

## Using the panel

| Area | What it shows |
|------|---------------|
| Table | One row per recorded call: time, method, status, duration, summary. |
| Status colour | Green `ok`, amber `pending`, red `failed` or `error`. |
| **Contract calls only** | Hides read-only calls such as `getLatestLedger` and `getLedgerEntries`. |
| **Clear** | Empties the table. |
| Row click | Opens the raw JSON request and response for that call. |

### Contract interaction inspection

For `simulateTransaction` the panel shows the ledger the simulation ran against, the minimum
resource fee, the number of results and events, whether a restore preamble is required, and
any simulation error. A simulation error is marked `failed` before the transaction is sent,
which is where most contract problems show up.

### Transaction inspection

- `sendTransaction`: the transaction hash and submission status (`PENDING`, `DUPLICATE`,
  `TRY_AGAIN_LATER` show as `pending`; `ERROR` as `failed`).
- `getTransaction`: final status (`SUCCESS`, `FAILED`, `NOT_FOUND`), the ledger it was
  included in, and the result XDR.

## How it works

The extension uses the `chrome.devtools.network` API, which receives every finished request
in the inspected page. For each request with a JSON-RPC body:

1. `src/inspect.js` checks the method against the Soroban RPC methods the panel tracks. Other
   traffic is ignored.
2. The response body is read with `getContent()` (base64 bodies are decoded).
3. The result is summarised per method and classified as `ok`, `pending`, `failed` or `error`.
4. `panel.js` renders the row. Response data is inserted with `textContent`, never `innerHTML`,
   because RPC responses are untrusted.

The extension requests **no permissions**. It reads only the DevTools network log for the
tab it is attached to.

## Development

```bash
cd tools/devtools-extension
npm test                # unit tests for src/inspect.js (node:test, no dependencies)
node --check panel.js   # syntax check for the browser entry points
```

The parsing logic is kept free of Chrome APIs so it can be tested under Node. To add a
method, add it to `SOROBAN_METHODS`, teach `summarizeResult()` which fields to show, and add a
test to `test/inspect.test.js`.

To test in Chrome after a change, click **Reload** on the extension in `chrome://extensions`,
then reopen DevTools.

## Limitations

- **XDR is not decoded.** Transaction envelopes, results and events are shown as base64 XDR.
  Decoding them needs the Stellar SDK, which is not bundled yet.
- **Only recorded calls appear.** Calls made in a page opened before DevTools is attached
  are not captured unless the page is reloaded.
- **No icons.** Chrome shows a default icon. Add 16/48/128 px icons and an `icons` entry to
  `manifest.json` before publishing.
- **Not published.** It is loaded unpacked from this repository only.

## Troubleshooting

- **Panel is empty**: confirm the page is calling the Soroban RPC (check the Network tab), and
  that the request body is JSON-RPC with a supported `method`.
- **Rows show `error`**: the RPC returned a JSON-RPC error. Open the row to read the message.
- **Panel missing after changes**: reload the extension in `chrome://extensions`, then close and
  reopen DevTools.
