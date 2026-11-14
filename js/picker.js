// Searchable symbol picker: live price / 24h change / volume per row, sort tabs,
// keyboard navigation (↑ ↓ Enter Esc) and "/" to open from anywhere.
import * as F from './fmt.js';
import { t } from './i18n.js';

export function createPicker(root, { getRows, getSel, onPick }) {
  const btn = root.querySelector('.pk-btn');
  const pop = root.querySelector('.pk-pop');
  const input = root.querySelector('.pk-q');
  const list = root.querySelector('.pk-list');
  const tabs = root.querySelector('.pk-tabs');
  let open = false, sort = 'vol', idx = 0, rows = [];

  function render(keepScroll = true) {
    const top = list.scrollTop;
    rows = getRows(sort, input.value.trim().toUpperCase());
    idx = Math.max(0, Math.min(idx, rows.length - 1));
    const sel = getSel();
    list.innerHTML = rows.length
      ? rows.map((r, i) => `<div class="pk-row${i === idx ? ' act' : ''}${r.pair === sel ? ' sel' : ''}" data-i="${i}">` +
          `<span class="pk-b">${F.esc(r.base)}${r.perp ? '<i>P</i>' : ''}</span><span>${F.price(r.last)}</span>` +
          `<span class="${F.cls(r.chg)}">${F.pct(r.chg)}</span><span>${F.usd(r.qv)}</span></div>`).join('')
      : `<div class="pk-empty">${F.esc(t('pk.none'))}</div>`;
    if (keepScroll) list.scrollTop = top;
  }
  function scrollAct() { list.children[idx]?.scrollIntoView({ block: 'nearest' }); }
  function show() {
    open = true; pop.hidden = false; root.classList.add('open');
    input.value = ''; idx = 0; list.scrollTop = 0;
    input.placeholder = t('pk.search');
    render(false); input.focus();
  }
  function hide() { open = false; pop.hidden = true; root.classList.remove('open'); }
  function choose(i) { const r = rows[i]; if (r) { onPick(r.pair); hide(); } }

  btn.addEventListener('click', (e) => { e.stopPropagation(); open ? hide() : show(); });
  document.addEventListener('pointerdown', (e) => { if (open && !root.contains(e.target)) hide(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); show(); }
  });
  input.addEventListener('input', () => { idx = 0; list.scrollTop = 0; render(false); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(rows.length - 1, idx + 1); render(); scrollAct(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); render(); scrollAct(); e.preventDefault(); }
    else if (e.key === 'Enter') choose(idx);
    else if (e.key === 'Escape') hide();
  });
  list.addEventListener('click', (e) => { const row = e.target.closest('.pk-row'); if (row) choose(+row.dataset.i); });
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    sort = b.dataset.s;
    tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    idx = 0; list.scrollTop = 0; render(false); input.focus();
  });
  setInterval(() => { if (open) render(); }, 1500);

  return { refresh: () => open && render() };
}
