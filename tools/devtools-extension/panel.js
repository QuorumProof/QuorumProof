// QuorumProof DevTools panel (#1674).
//
// Records Soroban RPC calls finished in the inspected page and shows them in a table.
// Parsing lives in src/inspect.js so it can be tested without Chrome.
import { buildRow } from './src/inspect.js';

const state = { rows: [], selected: null };

const el = {
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  contractOnly: document.getElementById('contract-only'),
  clear: document.getElementById('clear'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detail-title'),
  detailBody: document.getElementById('detail-body'),
  detailClose: document.getElementById('detail-close'),
};

/** Decode a HAR response body, which DevTools may return base64-encoded. */
function decodeBody(content, encoding) {
  if (!content || encoding !== 'base64') return content ?? '';
  try {
    return atob(content);
  } catch {
    return '';
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function summaryText(summary) {
  return Object.entries(summary)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
}

function visibleRows() {
  return el.contractOnly.checked ? state.rows.filter((r) => r.kind === 'contract') : state.rows;
}

function renderRow(row, index) {
  const tr = document.createElement('tr');
  tr.dataset.index = String(index);
  if (state.selected === index) tr.classList.add('selected');

  const cells = [
    formatTime(row.startedAt),
    row.method,
    row.status,
    `${row.durationMs} ms`,
    summaryText(row.summary) || (row.error ? row.error.message : ''),
  ];
  cells.forEach((text, i) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (i === 2) td.className = `status-${row.status}`;
    tr.appendChild(td);
  });
  return tr;
}

function render() {
  const rows = visibleRows();
  el.rows.replaceChildren(...rows.map((row) => renderRow(row, state.rows.indexOf(row))));
  el.empty.hidden = state.rows.length > 0;
  el.count.textContent = `${rows.length} of ${state.rows.length} calls`;
}

function showDetail(index) {
  const row = state.rows[index];
  if (!row) return;
  state.selected = index;
  el.detailTitle.textContent = `${row.method} (${row.status})`;
  // textContent, not innerHTML: RPC response data is untrusted.
  el.detailBody.textContent = JSON.stringify(row.raw, null, 2);
  el.detail.hidden = false;
  render();
}

function hideDetail() {
  state.selected = null;
  el.detail.hidden = true;
  render();
}

el.rows.addEventListener('click', (event) => {
  const tr = event.target.closest('tr[data-index]');
  if (tr) showDetail(Number(tr.dataset.index));
});
el.contractOnly.addEventListener('change', render);
el.clear.addEventListener('click', () => {
  state.rows = [];
  hideDetail();
});
el.detailClose.addEventListener('click', hideDetail);

chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  // Skip requests without a body before paying for getContent().
  if (!harEntry.request?.postData?.text) return;
  harEntry.getContent((content, encoding) => {
    const row = buildRow(harEntry, decodeBody(content, encoding));
    if (!row) return;
    state.rows.push(row);
    render();
  });
});

render();
