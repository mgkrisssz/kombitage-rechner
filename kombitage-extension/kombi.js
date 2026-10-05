'use strict';

/* ── Konstanten ── */
const W_START = 6 * 60, W_END = 20 * 60, SPAN = W_END - W_START;
const DEFAULT_SAP_URL = 'https://zkrcip010001.sap.intranet.zkw.at:44300/sap/bc/ui2/flp#ZHR_Virtuelles_Terminal-create';
const DEFAULTS = { threshold: 51, quota: 60, quotaMonthly: 0, soll: 462, normalDay: 492, lunch: 30, lwStart: 600, lwEnd: 840, live: false, liveMin: 5, sapUrl: DEFAULT_SAP_URL };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const K = { days: 'kombi:days', settings: 'kombi:settings', theme: 'kombi:theme', lastSap: 'kombi:lastSap', sap: 'kombi:sap' };

/* ── Block-Orte (Büro / Heim / Arzt) ── */
const LOC = {
  buro: { cls: 'buro', icon: '🏢', label: 'Büro' },
  heim: { cls: 'heim', icon: '🏠', label: 'Heim' },
  arzt: { cls: 'arzt', icon: '🩺', label: 'Arzt' }
};
const LOC_NEXT = { buro: 'heim', heim: 'arzt', arzt: 'buro' };   // Ort-Tausch zyklisch
const locOf = l => LOC[l] || LOC.buro;
const MIN_BLOCK = 5;        // kürzestmöglicher Block in Minuten

/* ── State ── */
let S = { ...DEFAULTS };
let days = {};              // { 'YYYY-MM-DD': [ {start,end,loc,open,source} ] }
let sapInfo = { teleConsumed: null, teleRaw: null, glz: null, at: null };   // offizieller Stand aus der SAP-Anspruchsseite
let NOW = 0;
let sel;
let ovScope = 'year';      // 'year' | 'month'
let syncing = false;
let liveTimer = null, ticker = null, nextAt = null;

/* ── Helpers ── */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const toTime = m => { m = Math.round(m); return pad(Math.floor(m / 60)) + ':' + pad(((m % 60) + 60) % 60); };
const dur = m => { m = Math.round(Math.max(0, m)); const h = Math.floor(m / 60), mm = m % 60; return h ? (mm ? h + 'h ' + mm + 'min' : h + ' Std') : mm + ' Min'; };
const clampSnap = m => Math.round(Math.min(Math.max(m, W_START), W_END));   // minutengenau (früher 5-Min-Raster)
const minToX = (m, w) => (m - W_START) * w / SPAN;
const xToMin = (x, w) => W_START + x * SPAN / w;
const parseHM = s => { const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/); if (!m) return null; const h = +m[1], mm = +m[2]; if (h > 23 || mm > 59) return null; return h * 60 + mm; };
// Flexible Eingabe: "10:30", "1030", "930", "9" → Minuten. Erkennt fehlenden Doppelpunkt automatisch.
const parseFlexHM = s => {
  s = String(s).trim(); if (!s) return null;
  const c = parseHM(s); if (c != null) return c;
  const d = s.replace(/\D/g, ''); if (!d) return null;
  let h, mm;
  if (d.length <= 2) { h = +d; mm = 0; }
  else if (d.length === 3) { h = +d.slice(0, 1); mm = +d.slice(1); }
  else { h = +d.slice(0, 2); mm = +d.slice(2, 4); }
  if (h > 23 || mm > 59) return null; return h * 60 + mm;
};
const fmtHM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const fmtCd = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return pad(Math.floor(t / 60)) + ':' + pad(t % 60); };
const decH = h => (h < 0 ? '− ' : '') + Math.abs(h).toFixed(2).replace('.', ',') + ' h';   // Dezimalstunden mit Komma, wie SAP GLZ-Saldo
const durSigned = m => (m < 0 ? '− ' : '') + dur(Math.abs(m));                                // Std/Min mit Vorzeichen

/* ── Datum ── */
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDE = iso => { const d = fromIso(iso); return WD[d.getDay()] + ', ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear(); };
const addDays = (iso, n) => { const d = fromIso(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const TODAY = isoOf(new Date());
sel = TODAY;

/* ── Persistenz ── */
function loadStore() {
  try { const s = JSON.parse(localStorage.getItem(K.settings) || '{}'); S = { ...DEFAULTS, ...s }; } catch (_) { S = { ...DEFAULTS }; }
  try {
    const d = JSON.parse(localStorage.getItem(K.days) || '{}');
    days = {};
    if (d && typeof d === 'object') {
      for (const iso of Object.keys(d)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Array.isArray(d[iso])) continue;
        days[iso] = d[iso]
          .map(b => ({ start: +b.start, end: +b.end, loc: (b.loc === 'heim' || b.loc === 'arzt') ? b.loc : 'buro', open: !!b.open, source: b.source || 'MANUAL' }))
          .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
      }
    }
  } catch (_) { days = {}; }
  try { const sp = JSON.parse(localStorage.getItem(K.sap) || 'null'); if (sp && typeof sp === 'object') sapInfo = { teleConsumed: null, teleRaw: null, glz: null, at: null, ...sp }; } catch (_) {}
}
function saveDays() { try { localStorage.setItem(K.days, JSON.stringify(days)); } catch (_) {} }
function saveSettings() { try { localStorage.setItem(K.settings, JSON.stringify(S)); } catch (_) {} }
function saveSapInfo() { try { localStorage.setItem(K.sap, JSON.stringify(sapInfo)); } catch (_) {} }

/* ── Offene (laufende) Stempelung heute bis "jetzt" mitführen ── */
function syncOpenEnds() {
  const list = days[TODAY];
  if (!list) return;
  list.forEach(b => { if (b.open) b.end = Math.max(b.start + 5, Math.min(nowMin(), W_END)); });
}

/* ── Rechnen ── */
function calc(iso) {
  const list = days[iso] || [];
  const isToday = iso === TODAY;
  const arr = [...list].sort((a, b) => a.start - b.start);
  let buro = 0, heim = 0, arzt = 0, inWPause = 0, excess = 0;
  arr.forEach(b => { const d = b.end - b.start; if (d > 0) { if (b.loc === 'buro') buro += d; else if (b.loc === 'heim') heim += d; else arzt += d; } });
  for (let i = 0; i < arr.length - 1; i++) {
    const gap = arr[i + 1].start - arr[i].end; if (gap <= 0) continue;
    const inW = arr[i].end >= S.lwStart && arr[i].end < S.lwEnd;
    if (inW) { inWPause += Math.min(gap, S.lunch); excess += Math.max(0, gap - S.lunch); }
    else excess += gap;
  }
  const rawAnw = buro + heim + arzt, gross = rawAnw + inWPause;
  const pauseFromWork = gross > 360 ? Math.max(0, S.lunch - inWPause) : 0;
  const netto = rawAnw - pauseFromWork;
  const ratioNet = buro + heim - pauseFromWork;                 // Arzt zählt zur Arbeitszeit, aber nicht zum Büro-Anteil
  const pct = ratioNet > 0 ? buro / ratioNet * 100 : null;
  const isBuro = pct != null && heim === 0;
  const isKombi = pct != null && !isBuro && (+pct.toFixed(1)) >= S.threshold;
  const klass = pct == null ? null : (isBuro ? 'buro' : (isKombi ? 'kombi' : 'tele'));
  const open = isToday && arr.length && !!arr[arr.length - 1].open;
  const fin = arr[arr.length - 1];
  const gz = netto - S.soll;
  let plan = null;
  if (open && fin && fin.loc !== 'arzt') {
    if (fin.loc === 'buro') {
      const minBuro = Math.max(Math.ceil(S.soll * S.threshold / 100), heim > 0 ? Math.ceil(heim * S.threshold / (100 - S.threshold)) : 0);
      const need = Math.max(0, minBuro - buro);
      plan = { mode: 'buro', fruh: toTime(Math.max(fin.end, NOW) + need), need, normEnde: toTime(arr[0].start + S.normalDay + excess) };
    } else if (buro > 0) {
      const rem = Math.max(0, Math.floor(buro * (100 - S.threshold) / S.threshold) - heim);
      plan = { mode: 'heim', spat: toTime(NOW + rem), spatRaw: NOW + rem, rem, normEnde: toTime(arr[0].start + S.normalDay + excess) };
    } else {
      const nb = Math.ceil(S.soll * S.threshold / 100);
      const spatMin = arr[0].start + S.normalDay + excess - nb;
      plan = { mode: 'heim0', spatBuro: toTime(spatMin), spatBuroRaw: spatMin, tooLate: NOW > spatMin, nb, normEnde: toTime(arr[0].start + S.normalDay + excess) };
    }
  }
  return { arr, buro, heim, arzt, rawAnw, netto, inWPause, pauseFromWork, pct, isBuro, isKombi, klass, fin, open, gz, plan, excess };
}

/* ── Balken ── */
function renderTrack() {
  const track = $('track'), axis = $('axis');
  const w = track.clientWidth || track.getBoundingClientRect().width || 760;
  track.innerHTML = ''; axis.innerHTML = '';
  for (let h = 6; h <= 20; h += 2) { const s = document.createElement('span'); s.textContent = pad(h) + ':00'; axis.appendChild(s); }
  for (let m = W_START; m <= W_END; m += 15) { const gl = document.createElement('div'); gl.className = 'grid-line ' + (m % 60 === 0 ? 'major' : (m % 30 === 0 ? 'half' : 'q')); gl.style.left = minToX(m, w) + 'px'; track.appendChild(gl); }
  const list = days[sel] || [];
  const c = calc(sel);
  if (!list.length) { const e = document.createElement('div'); e.className = 'tl-empty'; e.textContent = 'Noch leer — Block einfügen oder SAP Sync'; track.appendChild(e); }
  if (sel === TODAY && NOW >= W_START && NOW <= W_END) { const nl = document.createElement('div'); nl.className = 'now-line'; nl.style.left = minToX(NOW, w) + 'px'; track.appendChild(nl); }
  if (c.plan && c.plan.mode === 'buro' && c.plan.need > 0) { const t = Math.max(c.fin.end, NOW) + c.plan.need; if (t <= W_END) { const tl = document.createElement('div'); tl.className = 'target-line'; tl.dataset.label = 'Kombi ' + toTime(t) + ' · noch ' + dur(c.plan.need); tl.style.left = minToX(t, w) + 'px'; track.appendChild(tl); } }
  if (c.plan && c.plan.mode === 'heim0' && c.plan.spatBuroRaw >= W_START && c.plan.spatBuroRaw <= W_END) { const dl = document.createElement('div'); dl.className = 'deadline-line'; dl.dataset.label = c.plan.tooLate ? 'Büro-Frist verpasst' : 'Spät. Büro ' + c.plan.spatBuro; dl.style.left = minToX(c.plan.spatBuroRaw, w) + 'px'; track.appendChild(dl); }
  if (c.plan && c.plan.mode === 'heim' && c.plan.rem > 0 && c.plan.spatRaw >= W_START && c.plan.spatRaw <= W_END) { const dl = document.createElement('div'); dl.className = 'deadline-line'; dl.dataset.label = 'Heim bis ' + c.plan.spat; dl.style.left = minToX(c.plan.spatRaw, w) + 'px'; track.appendChild(dl); }
  const idx = list.map((_, i) => i).sort((a, b) => list[a].start - list[b].start);
  idx.forEach(oi => {
    const b = list[oi];
    const left = minToX(b.start, w), width = Math.max(46, minToX(b.end, w) - left);
    const L = locOf(b.loc);
    const el = document.createElement('div');
    el.className = 'block ' + L.cls + (width < 104 ? ' compact' : '');
    el.style.left = left + 'px'; el.style.width = width + 'px'; el.dataset.i = oi;
    el.innerHTML =
      '<div class="handle l"></div><div class="handle r"></div>' +
      '<div class="block-top"><span class="block-type">' + L.icon + ' ' + L.label + '</span></div>' +
      '<div class="block-acts"><button class="b-act" data-act="edit" title="Zeiten eingeben">✎</button><button class="b-act" data-act="swap" title="Ort wechseln">⇄</button><button class="b-act" data-act="del" title="Löschen">✕</button></div>' +
      '<div class="block-time">' + toTime(b.start) + '–' + toTime(b.end) + (b.open ? ' · live' : '') + '</div>';
    track.appendChild(el);
  });
  for (let i = 0; i < c.arr.length - 1; i++) {
    const g0 = c.arr[i].end, g1 = c.arr[i + 1].start;
    if (g1 > g0 && g0 >= S.lwStart && g0 < S.lwEnd) { const pe = Math.min(g1, g0 + S.lunch); const pp = document.createElement('div'); pp.className = 'pause-pill'; pp.style.left = minToX(g0, w) + 'px'; pp.style.width = Math.max(6, minToX(pe, w) - minToX(g0, w)) + 'px'; track.appendChild(pp); }
  }
  attachDrag(track);
}

function attachDrag(track) {
  const list = days[sel] || [];
  track.querySelectorAll('.block').forEach(el => {
    const oi = +el.dataset.i;
    el.querySelectorAll('.b-act').forEach(btn => {
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'edit') { openBlockEditor(track, oi); return; }
        if (act === 'del') list.splice(oi, 1);
        else { list[oi].loc = LOC_NEXT[list[oi].loc] || 'heim'; list[oi].source = 'MANUAL'; }
        saveDays(); renderAll();
      });
    });
    const start = mode => e => {
      e.preventDefault(); e.stopPropagation(); el.classList.add('dragging');
      const rect = track.getBoundingClientRect(); const b = list[oi];
      const sorted = [...list].sort((a, z) => a.start - z.start); const pos = sorted.indexOf(b);
      const prevEnd = pos > 0 ? sorted[pos - 1].end : W_START, nextStart = pos < sorted.length - 1 ? sorted[pos + 1].start : W_END;
      const grab = xToMin(e.clientX - rect.left, rect.width), off = grab - b.start, len = b.end - b.start;
      const move = ev => {
        const m = xToMin(Math.min(Math.max(ev.clientX - rect.left, 0), rect.width), rect.width);
        if (mode === 'move') { let ns = clampSnap(m - off); ns = Math.min(Math.max(ns, prevEnd), nextStart - len); b.start = ns; b.end = ns + len; }
        else if (mode === 'l') b.start = Math.min(Math.max(clampSnap(m), prevEnd), b.end - MIN_BLOCK);
        else { b.end = Math.max(Math.min(clampSnap(m), nextStart), b.start + MIN_BLOCK); b.open = false; }
        b.source = 'MANUAL';
        renderLight();
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); saveDays(); renderAll(); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };
    el.addEventListener('pointerdown', start('move'));
    el.querySelector('.handle.l').addEventListener('pointerdown', start('l'));
    el.querySelector('.handle.r').addEventListener('pointerdown', start('r'));
  });
}

/* ── Minutengenaue Zeit-Eingabe pro Block ── */
function openBlockEditor(track, oi) {
  const host = track.parentElement || track;
  host.querySelectorAll('.blk-editor').forEach(e => e.remove());
  const list = days[sel] || []; const b = list[oi]; if (!b) return;
  const w = track.clientWidth || 760;
  const ed = document.createElement('div');
  ed.className = 'blk-editor';
  ed.style.left = Math.min(Math.max(0, minToX(b.start, w) - 6), Math.max(0, w - 244)) + 'px';
  ed.innerHTML =
    '<div class="be-row"><label>Von</label><input class="be-in" id="beStart" inputmode="numeric" maxlength="5" value="' + toTime(b.start) + '">' +
    '<label>Bis</label><input class="be-in" id="beEnd" inputmode="numeric" maxlength="5" value="' + toTime(b.end) + '"></div>' +
    '<div class="be-hint" id="beHint">Uhrzeit eingeben — „1030“ wird zu 10:30.</div>' +
    '<div class="be-actions"><button class="be-ok" id="beOk">Übernehmen</button><button class="be-cancel" id="beCancel">Abbrechen</button></div>';
  host.appendChild(ed);
  const inS = ed.querySelector('#beStart'), inE = ed.querySelector('#beEnd'), hint = ed.querySelector('#beHint');
  const close = () => ed.remove();
  const fail = msg => { hint.textContent = msg; hint.classList.add('err'); };
  const apply = () => {
    const ns = parseFlexHM(inS.value), ne = parseFlexHM(inE.value);
    if (ns == null || ne == null) return fail('Ungültige Uhrzeit — z. B. 10:30 oder 1030.');
    if (ns < W_START || ne > W_END) return fail('Nur zwischen ' + toTime(W_START) + ' und ' + toTime(W_END) + '.');
    if (ne - ns < MIN_BLOCK) return fail('Block muss mind. ' + MIN_BLOCK + ' Min lang sein.');
    if (list.some((o, i) => i !== oi && ns < o.end && ne > o.start)) return fail('Überschneidet einen anderen Block.');
    b.start = ns; b.end = ne; b.open = false; b.source = 'MANUAL';
    saveDays(); close(); renderAll();
  };
  ed.querySelector('#beOk').addEventListener('click', apply);
  ed.querySelector('#beCancel').addEventListener('click', close);
  ed.addEventListener('pointerdown', e => e.stopPropagation());
  [inS, inE].forEach(inp => {
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    // Beim Verlassen automatisch zu HH:MM formatieren, damit man sieht, was erkannt wurde.
    inp.addEventListener('blur', () => { const v = parseFlexHM(inp.value); if (v != null) inp.value = toTime(v); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } else if (e.key === 'Escape') close(); });
  });
  inS.focus(); inS.select();
}

function renderLight() {
  const track = $('track'); const w = track.clientWidth || 760; const list = days[sel] || [];
  track.querySelectorAll('.block').forEach(el => {
    const b = list[+el.dataset.i]; if (!b) return;
    const left = minToX(b.start, w), width = Math.max(46, minToX(b.end, w) - left);
    el.style.left = left + 'px'; el.style.width = width + 'px'; el.classList.toggle('compact', width < 104);
    el.querySelector('.block-time').textContent = toTime(b.start) + '–' + toTime(b.end) + (b.open ? ' · live' : '');
  });
  renderPanels();
}

/* ── Panels ── */
function renderStats(c) {
  const bA = c.open && c.fin && c.fin.loc === 'buro', hA = c.open && c.fin && c.fin.loc === 'heim';
  const pctFmt = c.pct != null ? c.pct.toFixed(1) + '%' : '—';
  const totalPause = c.inWPause + c.pauseFromWork;
  $('stats').innerHTML =
    '<div class="stat ' + (bA ? 'on-amber' : '') + '"><div class="stat-lbl" style="color:' + (bA ? 'var(--amber)' : 'var(--muted)') + '">🏢 Büro ' + (bA ? '<span class="live-dot"></span>' : '') + '</div><div class="stat-val" style="color:var(--amber)">' + dur(c.buro) + '</div><div class="stat-pct">' + (c.pct != null ? pctFmt : '&nbsp;') + '</div></div>' +
    '<div class="stat ' + (hA ? 'on-blue' : '') + '"><div class="stat-lbl" style="color:' + (hA ? 'var(--blue)' : 'var(--muted)') + '">🏠 Heim ' + (hA ? '<span class="live-dot"></span>' : '') + '</div><div class="stat-val" style="color:var(--blue)">' + dur(c.heim) + '</div><div class="stat-pct">' + (c.pct != null && !c.isBuro ? (100 - c.pct).toFixed(1) + '%' : '&nbsp;') + '</div></div>' +
    '<div class="stat"><div class="stat-lbl">' + (c.open ? '<span class="live-dot"></span> Live ' + toTime(NOW) : 'Anwesenheit') + '</div><div class="stat-val">' + dur(c.rawAnw) + '</div><div class="stat-pct">' + (c.arzt > 0 ? 'inkl. 🩺 ' + dur(c.arzt) : 'Anwesenheit') + '</div></div>' +
    '<div class="stat"><div class="stat-lbl">Nettoarbeitszeit</div><div class="stat-val" style="color:var(--green)">' + dur(c.netto) + '</div><div class="stat-pct">' + (totalPause > 0 ? '− ' + totalPause + ' Min Pause' : 'ohne Pause') + '</div></div>';
}
function renderBar(c) {
  const pct = c.pct != null ? Math.min(100, c.pct) : 0;
  const col = c.pct == null ? 'var(--border)' : (c.pct >= S.threshold ? 'var(--green-border)' : c.pct >= 35 ? 'var(--amber)' : 'var(--red)');
  $('barFill').style.width = pct + '%'; $('barFill').style.background = col;
  const lbl = $('barMidLbl'); const p = c.plan;
  if (p && p.mode === 'buro' && p.need > 0) lbl.textContent = S.threshold + ' % · noch ' + dur(p.need) + ' Büro';
  else if (p && p.mode === 'heim0') lbl.textContent = S.threshold + ' % · noch ' + dur(p.nb) + ' Büro nötig';
  else if (p && p.mode === 'heim' && p.rem > 0) lbl.textContent = S.threshold + ' % ✓ · Heim noch ' + dur(p.rem);
  else if (p && p.mode === 'buro') lbl.textContent = S.threshold + ' % ✓ erreicht';
  else lbl.textContent = S.threshold + ' % Mindest';
}
function renderPanelsFull(c) {
  const sp = $('statusPanel'); let bg, brd, col, badge, sub;
  if (c.pct == null) { bg = 'var(--card-2)'; brd = 'var(--border)'; col = 'var(--muted)'; badge = 'Kein Eintrag'; sub = 'Block einfügen oder SAP Sync'; }
  else if (c.isBuro) { bg = 'var(--green-bg)'; brd = 'var(--green-border)'; col = 'var(--green)'; badge = '✓ Bürotag'; sub = '100 % Büroanteil — kostet nichts'; }
  else if (c.isKombi) {
    bg = 'var(--green-bg)'; brd = 'var(--green-border)'; col = 'var(--green)'; badge = '✓ Kombitag';
    sub = c.open ? (c.plan && c.plan.mode === 'heim' ? 'Heim möglich bis ' + c.plan.spat : c.pct.toFixed(1) + ' % Büro — gesichert') : c.pct.toFixed(1) + ' % Büroanteil — kostet nichts';
  } else {
    bg = 'var(--red-bg)'; brd = 'var(--red-border)'; col = 'var(--red)'; badge = '✗ Telearbeit';
    sub = c.open && c.plan && c.plan.mode === 'buro' && c.plan.need > 0 ? 'noch ' + dur(c.plan.need) + ' Büro → Kombitag' : 'Nur ' + c.pct.toFixed(1) + ' % Büro — 1 Tag vom Kontingent';
  }
  sp.style.background = bg; sp.style.borderColor = brd;
  sp.innerHTML = '<div class="panel-lbl" style="color:' + col + '">Status ' + (c.open ? '<span class="live-dot"></span>' : '') + '</div><div class="panel-badge" style="color:' + col + '">' + badge + '</div><div class="panel-sub" style="color:' + col + '">' + sub + '</div>' + (c.pct != null ? '<div class="mini-bar"><div class="mini-fill" style="width:' + Math.min(100, c.pct) + '%;background:' + col + '"></div><div class="mini-mark"></div></div>' : '');
  const gp = $('gzPanel');
  const gz = c.gz;                                  // heutiger Beitrag (Minuten, signiert)
  const hasWork = c.arr.length > 0;
  const glzKnown = sapInfo.glz != null;
  gp.style.background = 'var(--card-2)'; gp.style.borderColor = 'var(--border)';
  const sapRow = glzKnown
    ? '<div class="gz-saprow"><span class="gz-saplbl">SAP GLZ-Saldo 🔒</span><span class="mono gz-sapval" style="color:' + (parseFloat(sapInfo.glz) >= 0 ? 'var(--green)' : 'var(--red)') + '">' + String(sapInfo.glz).replace('.', ',') + ' h</span></div>'
    : '';
  let head;
  if (!hasWork) {
    head = '<div class="gz-val" style="color:var(--muted)">—</div><div class="panel-sub" style="color:var(--muted)">kein Eintrag</div>';
  } else {
    // Links: heutiger Beitrag (wie bisher). Rechts: hochgerechneter Kontostand.
    const lCol = gz >= 0 ? 'var(--green)' : (Math.abs(gz) < 60 ? 'var(--amber)' : 'var(--red)');
    const leftSub = c.open
      ? (gz >= 0 ? 'wenn du jetzt aufhörst · auf Konto' : 'wenn du jetzt aufhörst · vom Konto')
      : (gz >= 0 ? 'an dem Tag aufs Konto' : 'an dem Tag vom Konto');
    const left =
      '<div class="gz-col">' +
        '<div class="gz-val" style="color:' + lCol + '">' + (gz >= 0 ? '+ ' : '− ') + dur(Math.abs(gz)) + '</div>' +
        '<div class="panel-sub" style="color:' + lCol + '">' + leftSub + '</div>' +
      '</div>';
    let right;
    if (glzKnown) {
      // Hochgerechneter Kontostand = offizieller SAP-Saldo + heutiger Beitrag
      const projMin = Math.round(parseFloat(sapInfo.glz) * 60) + gz;
      const rCol = projMin >= 0 ? 'var(--green)' : 'var(--red)';
      right =
        '<div class="gz-col gz-col-r">' +
          '<div class="gz-val" style="color:' + rCol + '">' + decH(projMin / 60) + '</div>' +
          '<div class="gz-sub2 mono" style="color:' + rCol + '">' + durSigned(projMin) + '</div>' +
          '<div class="panel-sub" style="color:' + rCol + '">GLZ-Konto danach</div>' +
        '</div>';
    } else {
      right = '<div class="gz-col gz-col-r"><div class="gz-hint">SAP-Sync zeigt hier den<br>hochgerechneten Kontostand</div></div>';
    }
    head = '<div class="gz-cols">' + left + right + '</div>';
  }
  gp.innerHTML = '<div class="panel-lbl" style="color:var(--muted)">Gleitzeitkonto ' + (c.open ? '<span class="live-dot"></span>' : '') + '</div>' + head + sapRow;
}
function renderPlan(c) {
  const card = $('planCard');
  if (!c.open || !c.plan) { card.style.display = 'none'; return; }
  card.style.display = 'block'; const p = c.plan;
  const box = (lbl, time, sub, kind) => { const m = { amber: ['var(--amber-bg)', 'var(--amber-border)', 'var(--amber)'], blue: ['var(--blue-bg)', 'var(--blue-border)', 'var(--blue)'] }[kind]; return '<div class="pbox" style="background:' + m[0] + ';border-color:' + m[1] + '"><div class="pbox-lbl" style="color:' + m[2] + '">' + lbl + '</div><div class="pbox-time" style="color:' + m[2] + '">' + time + '</div><div class="pbox-sub" style="color:' + m[2] + '">' + sub + '</div></div>'; };
  let title, inner;
  if (p.mode === 'buro') { title = 'Planung · im Büro'; inner = box('Frühestens nach Hause', p.fruh, p.need > 0 ? 'noch ' + dur(p.need) + ' Büro → Kombitag' : 'Schwelle erreicht — Kombitag sicher', 'amber') + box('Normaltag Ende', '&nbsp;' + p.normEnde, 'Start + Normaltag-Länge', 'blue'); }
  else if (p.mode === 'heim') { title = 'Planung · im Heim'; inner = box('Spätestens ausstempeln', p.spat, p.rem === 0 ? 'Limit erreicht' : 'noch ' + dur(p.rem) + ' Heim möglich', 'amber') + box('Normaltag Ende', '&nbsp;' + p.normEnde, 'Start + Normaltag-Länge', 'blue'); }
  else { title = 'Planung · im Heim gestartet'; inner = box('Spätestens ins Büro', p.spatBuro, p.tooLate ? 'Frist überschritten' : 'noch ' + dur(p.nb) + ' Büro nötig', 'amber') + box('Normaltag Ende', '&nbsp;' + p.normEnde, 'Start + Normaltag-Länge', 'blue'); }
  card.innerHTML = '<div class="card-label">' + title + '</div><div class="plan-grid">' + inner + '</div>';
}

/* ── Datum + Tag-Badge ── */
function renderDate() {
  $('dateCur').textContent = fmtDE(sel);
  $('todayBtn').classList.toggle('active', sel === TODAY);
  const c = calc(sel); const tag = $('dayTag');
  const map = { buro: ['✓ Bürotag', 'var(--green)', 'var(--green-bg)', 'var(--green-border)'], kombi: ['✓ Kombitag', 'var(--amber)', 'var(--amber-bg)', 'var(--amber-border)'], tele: ['✗ Telearbeit', 'var(--red)', 'var(--red-bg)', 'var(--red-border)'] };
  if (!c.klass) { tag.style.display = 'none'; return; }
  tag.style.display = ''; const m = map[c.klass];
  tag.textContent = (sel === TODAY ? 'heute · ' : '') + m[0]; tag.style.color = m[1]; tag.style.background = m[2]; tag.style.borderColor = m[3];
}

/* ── Übersicht ── */
function countRange(pred) {
  let bt = 0, kt = 0, tt = 0;
  Object.keys(days).forEach(iso => { if (!pred(iso)) return; const k = calc(iso).klass; if (k === 'buro') bt++; else if (k === 'kombi') kt++; else if (k === 'tele') tt++; });
  return { bt, kt, tt };
}
function renderOverview() {
  const d = fromIso(sel), year = d.getFullYear(), month = d.getMonth();
  const monthScope = ovScope === 'month';
  $('ovSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.scope === ovScope));
  const pred = monthScope
    ? (iso => { const x = fromIso(iso); return x.getFullYear() === year && x.getMonth() === month; })
    : (iso => fromIso(iso).getFullYear() === year);
  const { bt, kt, tt } = countRange(pred);
  const limit = monthScope ? S.quotaMonthly : S.quota;
  const curYear = new Date().getFullYear();
  // Jahres-Telearbeit kommt aus dem offiziellen SAP-Verbrauch (falls vorhanden & gleiches Jahr), sonst lokal gezählt.
  const useSap = !monthScope && sapInfo.teleConsumed != null && year === curYear;
  const tele = useSap ? sapInfo.teleConsumed : tt;
  const rest = limit > 0 ? Math.max(0, limit - tele) : null;
  const scopeLbl = monthScope ? MONTHS[month].slice(0, 3) + ' ' + year : String(year);
  const teleSub = useSap ? ('von ' + (limit > 0 ? limit : '∞') + ' · laut SAP') : (limit > 0 ? ('von ' + limit + ' · ' + scopeLbl) : ('kein Limit · ' + scopeLbl));
  $('ovGrid').innerHTML =
    '<div class="ov-tile buro"><div class="ov-tile-lbl" style="color:var(--green)">🏢 Bürotage</div><div class="ov-tile-val" style="color:var(--green)">' + bt + '</div><div class="ov-tile-sub" style="color:var(--green)">kostenneutral</div></div>' +
    '<div class="ov-tile kombi"><div class="ov-tile-lbl" style="color:var(--amber)">⚡ Kombitage</div><div class="ov-tile-val" style="color:var(--amber)">' + kt + '</div><div class="ov-tile-sub" style="color:var(--amber)">kostenneutral</div></div>' +
    '<div class="ov-tile tele"><div class="ov-tile-lbl" style="color:var(--red)">🏠 Telearbeit' + (useSap ? ' 🔒' : '') + '</div><div class="ov-tile-val" style="color:var(--red)">' + tele + '</div><div class="ov-tile-sub" style="color:var(--red)">' + teleSub + '</div></div>' +
    '<div class="ov-tile rest"><div class="ov-tile-lbl" style="color:var(--muted)">Rest-Kontingent</div><div class="ov-tile-val" style="color:' + (rest != null && rest <= 5 ? 'var(--red)' : 'var(--ink)') + '">' + (rest == null ? '—' : rest) + '</div><div class="ov-tile-sub" style="color:var(--muted)">' + (limit > 0 ? 'Telearbeit übrig' : (monthScope ? 'kein Monatslimit' : 'kein Limit gesetzt')) + '</div></div>';
  $('quotaFill').style.width = (limit > 0 ? Math.min(100, tele / limit * 100) : 0) + '%';

  // Prognose / Warnung
  const proj = $('ovProj'); let txt = '', col = 'var(--muted)';
  if (limit > 0 && rest === 0) { txt = '⚠ Kontingent ausgeschöpft — weitere Telearbeit wäre kritisch.'; col = 'var(--red)'; }
  else if (!monthScope && year === curYear && tele > 0 && limit > 0) {
    const s = new Date(year, 0, 1), e = new Date(year + 1, 0, 1);
    const frac = Math.max(0.02, (Date.now() - s.getTime()) / (e.getTime() - s.getTime()));
    const pj = Math.round(tele / frac);
    if (pj > limit) { txt = '⚠ Hochrechnung: ~' + pj + ' Telearbeitstage bis Jahresende — über dem Limit (' + limit + ').'; col = 'var(--red)'; }
    else txt = 'Hochrechnung: ~' + pj + ' von ' + limit + ' bis Jahresende — im Rahmen.';
  }
  else if (monthScope && limit > 0) { txt = rest + ' von ' + limit + ' diesen Monat übrig.'; col = rest <= 1 ? 'var(--red)' : 'var(--muted)'; }
  proj.textContent = txt; proj.style.color = col; proj.style.display = txt ? 'flex' : 'none';

  // SAP-Stand-Zeile (offizieller Verbrauch + GLZ-Saldo)
  const sapLine = $('sapLine');
  if (sapInfo.teleConsumed != null || sapInfo.glz != null) {
    const parts = [];
    if (sapInfo.teleConsumed != null) parts.push('Telearbeit ' + sapInfo.teleConsumed + ' verbraucht');
    if (sapInfo.glz != null) parts.push('GLZ-Saldo ' + String(sapInfo.glz).replace('.', ',') + ' h');
    let stand = '';
    if (sapInfo.at) { const dd = new Date(sapInfo.at); stand = ' · Stand ' + pad(dd.getDate()) + '.' + pad(dd.getMonth() + 1) + '.'; }
    sapLine.textContent = '🔒 SAP: ' + parts.join(' · ') + stand;
    sapLine.style.display = 'flex';
  } else {
    sapLine.textContent = ''; sapLine.style.display = 'none';
  }

  renderCal(year, month);
}
function renderCal(year, month) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7;           // Montag = 0
  const dim = new Date(year, month + 1, 0).getDate();
  let html = '<div class="cal-head"><div class="cal-title">' + MONTHS[month] + ' ' + year + '</div></div><div class="cal-grid">';
  ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].forEach(x => { html += '<div class="cal-dow">' + x + '</div>'; });
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell empty"></div>';
  for (let day = 1; day <= dim; day++) {
    const iso = year + '-' + pad(month + 1) + '-' + pad(day);
    const k = calc(iso).klass;
    const wd = new Date(year, month, day).getDay();
    const cls = 'cal-cell ' + (k || '') + ((wd === 0 || wd === 6) ? ' weekend' : '') + (iso === TODAY ? ' today' : '') + (iso === sel ? ' sel' : '');
    html += '<div class="' + cls + '" data-iso="' + iso + '">' + day + '</div>';
  }
  html += '</div><div class="cal-legend"><span><i style="background:var(--green-border)"></i>Büro</span><span><i style="background:var(--amber-2)"></i>Kombi</span><span><i style="background:var(--red-border)"></i>Telearbeit</span></div>';
  const cal = $('cal'); cal.innerHTML = html;
  cal.querySelectorAll('.cal-cell[data-iso]').forEach(el => el.addEventListener('click', () => { sel = el.dataset.iso; renderAll(); }));
}

function renderPanels() { const c = calc(sel); renderStats(c); renderBar(c); renderPanelsFull(c); renderPlan(c); renderDate(); renderOverview(); }
function renderAll() { NOW = nowMin(); syncOpenEnds(); renderTrack(); renderPanels(); }

/* ── Aktionen ── */
function anchor() { const list = days[sel] || []; const s = [...list].sort((a, b) => a.end - b.end); return s.length ? s[s.length - 1].end : W_START; }
function addBlock(loc) {
  if (!days[sel]) days[sel] = []; const list = days[sel];
  const defLen = loc === 'arzt' ? 60 : 90;
  const sorted = [...list].sort((a, b) => a.start - b.start);
  // 1) Erste echte Lücke ZWISCHEN zwei Blöcken bevorzugen (dort will man i. d. R. einfügen).
  let cursor = W_START, slot = null;
  for (const b of sorted) {
    if (cursor > W_START && b.start - cursor >= MIN_BLOCK) { slot = { s: cursor, e: b.start }; break; }
    cursor = Math.max(cursor, b.end);
  }
  // 2) Sonst hinten anhängen (bzw. leerer Tag am Fensteranfang).
  if (!slot) {
    let s = sorted.length ? cursor : W_START;
    if (s >= W_END - MIN_BLOCK) s = W_START;
    slot = { s, e: W_END };
  }
  const s = slot.s, e = Math.min(s + defLen, slot.e);
  list.push({ start: clampSnap(s), end: clampSnap(e), loc, open: false, source: 'MANUAL' });
  saveDays(); renderAll();
}

/* ── SAP-Sync ── */
function applySapData(data) {
  const byDate = {};
  (data.blocks || []).forEach(b => {
    const loc = b.location === 'HO' ? 'heim' : 'buro';
    (byDate[b.date] ||= []).push({ start: +b.start, end: +b.end, loc, open: !!b.open, source: 'SAP' });
  });
  const dates = Object.keys(byDate);
  dates.forEach(iso => { byDate[iso].sort((a, b) => a.start - b.start); days[iso] = byDate[iso]; });
  saveDays();
  try { localStorage.setItem(K.lastSap, new Date().toISOString()); } catch (_) {}
  return dates.length;
}
function runSap(auto) {
  if (syncing) return;
  const btn = $('sapBtn'), hint = $('tlHint');
  btn.classList.remove('err');
  if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
    toast('SAP Sync braucht die Chrome-Extension-Umgebung.', true);
    hint.textContent = 'Diese Seite muss als Extension laufen, um SAP zu lesen.'; hint.className = 'tl-hint err';
    return;
  }
  syncing = true; renderPill();
  hint.textContent = 'SAP wird im Hintergrund gelesen …'; hint.className = 'tl-hint sap';
  function fail(msg) {
    btn.classList.add('err');
    const notAuthed = /anmeld|angemeldet|freigabe|stempeldaten|login|sign\s*-?in|session|not\s*found|no tab/i.test(msg || '');
    hint.textContent = notAuthed
      ? '🔒 Du bist (noch) nicht in SAP angemeldet. Bitte im SAP-Tab anmelden bzw. freigeben und erneut auf „Sync“ klicken.'
      : 'SAP nicht gelesen: ' + msg + ' Im SAP-Tab anmelden/freigeben, dann erneut Sync.';
    hint.className = 'tl-hint err';
    if (!auto) toast(notAuthed ? 'SAP: Du bist nicht angemeldet' : 'SAP: ' + msg, true);
    renderPill(); schedule();
  }
  chrome.runtime.sendMessage({ type: 'KOMBI_SAP_SYNC', sapUrl: S.sapUrl || DEFAULT_SAP_URL }, resp => {
    syncing = false;
    if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
    if (!resp || !resp.ok) { fail((resp && resp.error) || 'SAP Sync fehlgeschlagen.'); return; }
    const n = applySapData(resp.data);
    const warn = (resp.data && resp.data.warnings) || [];
    const leave = resp.data && resp.data.leave;
    if (leave && (leave.teleworkConsumed != null || leave.glz != null)) {
      sapInfo = { teleConsumed: leave.teleworkConsumed != null ? leave.teleworkConsumed : sapInfo.teleConsumed, teleRaw: leave.teleworkRaw || null, glz: leave.glz != null ? leave.glz : sapInfo.glz, at: new Date().toISOString() };
      saveSapInfo();
    }
    sel = TODAY; renderAll();
    const teleTxt = sapInfo.teleConsumed != null ? ' · Telearbeit ' + sapInfo.teleConsumed + ' verbraucht (SAP)' : '';
    hint.textContent = 'SAP-Stand übernommen' + (warn.length ? ' · ' + warn.length + ' Hinweis(e)' : '') + teleTxt + ' · read-only.'; hint.className = 'tl-hint sap';
    hint.title = warn.join('\n');
    if (warn.length) {
      const list = document.createElement('div');
      list.style.cssText = 'margin-top:4px;opacity:.85;font-size:.92em';
      warn.forEach(w => { const d = document.createElement('div'); d.textContent = '• ' + w; list.appendChild(d); });
      hint.appendChild(list);
    }
    toast('SAP gelesen · ' + n + ' Tag' + (n === 1 ? '' : 'e') + (sapInfo.teleConsumed != null ? ' · ' + sapInfo.teleConsumed + ' Telearbeit verbraucht' : '') + ' (read-only)');
    renderPill(); schedule();
  });
}

/* ── Auto-Refresh ── */
function schedule() {
  clearTimeout(liveTimer); liveTimer = null; nextAt = null;
  if (!S.live) { if (ticker) { clearInterval(ticker); ticker = null; } renderPill(); return; }
  const delay = Math.max(1, S.liveMin) * 60000;
  nextAt = Date.now() + delay;
  liveTimer = setTimeout(() => runSap(true), delay);
  if (!ticker) ticker = setInterval(renderPill, 1000);
  renderPill();
}
function renderPill() {
  const btn = $('sapBtn'), cd = $('sapCd');
  btn.classList.toggle('live', S.live && !syncing);
  btn.classList.toggle('running', syncing);
  if (syncing) { cd.textContent = 'läuft…'; return; }
  if (S.live && nextAt) cd.textContent = 'Live ' + fmtCd(nextAt - Date.now());
  else cd.textContent = '';
}

/* ── Einstellungen ── */
function openSettings() {
  $('s_threshold').value = S.threshold; $('s_quota').value = S.quota; $('s_quotaMonthly').value = S.quotaMonthly;
  $('s_soll').value = fmtHM(S.soll); $('s_normal').value = fmtHM(S.normalDay);
  $('s_lunch').value = S.lunch; $('s_lwStart').value = fmtHM(S.lwStart); $('s_lwEnd').value = fmtHM(S.lwEnd);
  $('s_live').checked = !!S.live; $('s_liveMin').value = S.liveMin; $('s_sapUrl').value = S.sapUrl || DEFAULT_SAP_URL;
  $('mainView').style.display = 'none'; $('settingsView').style.display = 'block';
  $('setBtn').classList.add('on'); $('footNote').style.display = 'none';
  ['s_threshold', 's_quota', 's_quotaMonthly', 's_soll', 's_normal', 's_lunch', 's_lwStart', 's_lwEnd', 's_liveMin', 's_sapUrl'].forEach(id => $(id).classList.remove('err'));
}
function closeSettings() { $('settingsView').style.display = 'none'; $('mainView').style.display = 'block'; $('setBtn').classList.remove('on'); $('footNote').style.display = ''; }
function saveSettingsForm() {
  const th = parseInt($('s_threshold').value, 10), q = parseInt($('s_quota').value, 10), qm = parseInt($('s_quotaMonthly').value, 10), ln = parseInt($('s_lunch').value, 10), lm = parseInt($('s_liveMin').value, 10);
  const soll = parseHM($('s_soll').value), norm = parseHM($('s_normal').value), ws = parseHM($('s_lwStart').value), we = parseHM($('s_lwEnd').value);
  const url = ($('s_sapUrl').value || '').trim();
  let bad = false; const chk = (id, ok) => { $(id).classList.toggle('err', !ok); if (!ok) bad = true; };
  chk('s_threshold', th >= 1 && th <= 100); chk('s_quota', q >= 0); chk('s_quotaMonthly', qm >= 0); chk('s_soll', soll != null); chk('s_normal', norm != null);
  chk('s_lunch', ln >= 0); chk('s_lwStart', ws != null); chk('s_lwEnd', we != null && (ws == null || we > ws));
  chk('s_liveMin', lm >= 1); chk('s_sapUrl', /^https?:\/\//i.test(url));
  if (bad) { toast('Bitte Eingaben prüfen (rot markiert)', true); return; }
  S = { threshold: th, quota: q, quotaMonthly: qm, soll, normalDay: norm, lunch: ln, lwStart: ws, lwEnd: we, live: $('s_live').checked, liveMin: lm, sapUrl: url };
  saveSettings(); applyThresholdVar(); closeSettings(); renderAll(); schedule(); toast('Regeln gespeichert');
}
function resetSettings() { S = { ...DEFAULTS }; saveSettings(); openSettings(); applyThresholdVar(); }
function applyThresholdVar() { document.documentElement.style.setProperty('--thr', S.threshold + '%'); $('barMidLbl').textContent = S.threshold + ' % Mindest'; }

/* ── Toast ── */
function toast(msg, err) { const t = $('toast'); $('toastMsg').textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3000); }

/* ── Theme ── */
function currentTheme() { return document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); }
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙'; try { localStorage.setItem(K.theme, t); } catch (_) {} requestAnimationFrame(renderAll); }

/* ── Events ── */
$('addBuro').addEventListener('click', () => addBlock('buro'));
$('addHeim').addEventListener('click', () => addBlock('heim'));
$('addArzt').addEventListener('click', () => addBlock('arzt'));
$('clearBtn').addEventListener('click', () => { if (days[sel] && days[sel].length) { delete days[sel]; saveDays(); } renderAll(); });
$('prevDay').addEventListener('click', () => { sel = addDays(sel, -1); renderAll(); });
$('nextDay').addEventListener('click', () => { sel = addDays(sel, 1); renderAll(); });
$('todayBtn').addEventListener('click', () => { sel = TODAY; renderAll(); });
$('ovSeg').addEventListener('click', e => { const b = e.target.closest('button[data-scope]'); if (!b) return; ovScope = b.dataset.scope; renderOverview(); });
$('sapBtn').addEventListener('click', () => runSap(false));
$('setBtn').addEventListener('click', () => { $('settingsView').style.display === 'block' ? closeSettings() : openSettings(); });
$('saveSet').addEventListener('click', saveSettingsForm);
$('resetSet').addEventListener('click', resetSettings);
$('themeBtn').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
window.addEventListener('resize', () => requestAnimationFrame(() => { if ($('mainView').style.display !== 'none') renderTrack(); }));
setInterval(() => { NOW = nowMin(); if (sel === TODAY && $('mainView').style.display !== 'none') renderAll(); }, 60000);

/* ── Init ── */
loadStore();
setTheme(localStorage.getItem(K.theme) || currentTheme());
applyThresholdVar();
renderAll();
schedule();
