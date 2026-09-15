(() => {
  if (window.__kombiSapContentLoaded) return;
  window.__kombiSapContentLoaded = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).toLowerCase();

  const TAB_LABELS = [
    'time events',
    'time event',
    'auswertung',
    'auswertungen',
    'evaluation',
    'evaluations',
    'zeitauswertung'
  ];

  function isLikelyTimeEventsTab(el) {
    const text = norm(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    return TAB_LABELS.some(label => text === label || text.includes(label));
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function clickElementSafely(el) {
    if (!el) return false;
    const target = el.closest('[role="tab"], .sapMITBItem, .sapMITBHead .sapMITBFilter, .sapMBtn, button, a') || el;
    const selected = target.getAttribute('aria-selected') === 'true' || target.classList.contains('sapMITBSelected') || target.classList.contains('sapMITBFilterSelected');
    if (!selected) {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
    }
    return true;
  }

  function clickTimeEventsTabByText() {
    const els = [...document.querySelectorAll('[role="tab"], .sapMITBItem, .sapMITBFilter, .sapMITH .sapMITBFilter, button, a, span, div')]
      .filter(el => visible(el) && isLikelyTimeEventsTab(el));
    const preferred = els.find(el => el.getAttribute('role') === 'tab') ||
      els.map(el => el.closest('[role="tab"]')).find(Boolean) ||
      els.map(el => el.closest('.sapMITBItem, .sapMITBFilter')).find(Boolean) ||
      els[0];
    return clickElementSafely(preferred);
  }

  function clickSecondIconTabFallback() {
    // SAP Virtual Terminal has two large icon tabs: Terminal, then Time Events/Auswertung.
    // We only ever click the second tab-like item, never a Clock-in/Clock-out action button.
    const tabContainers = [
      ...document.querySelectorAll('.sapMITBHead, [role="tablist"], .sapMITH')
    ].filter(visible);

    for (const container of tabContainers) {
      const tabs = [...container.querySelectorAll('[role="tab"], .sapMITBItem, .sapMITBFilter')]
        .filter(visible);
      const unique = [];
      for (const t of tabs) if (!unique.some(u => u === t || u.contains(t) || t.contains(u))) unique.push(t);
      if (unique.length >= 2) return clickElementSafely(unique[1]);
    }

    // Do not click arbitrary buttons/links as fallback. This keeps the SAP page strictly read-only.
    return false;
  }

  function clickTimeEventsTab() {
    // In the current SAP UI snapshot the second tab is __filter1. Try this first, then language/text matching.
    const direct = document.getElementById('__filter1');
    if (direct && visible(direct)) return clickElementSafely(direct);
    return clickTimeEventsTabByText() || clickSecondIconTabFallback();
  }

  function hasTimeEventsTable() {
    const text = document.body ? document.body.innerText : '';
    const lower = text.toLowerCase();
    const hasDateHeader = text.includes('DateEN') || lower.includes('datum') || lower.includes('date');
    const hasTimeHeader = lower.includes('time') || lower.includes('uhrzeit') || lower.includes('zeit');
    const hasClockEvents = /Clock-in|Clock-out|P10|P20|Kommen|Gehen|Eintritt|Austritt/i.test(text);
    return hasDateHeader && hasTimeHeader && hasClockEvents;
  }

  async function waitForSapUi(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.body && clean(document.body.innerText).length > 200) return;
      await sleep(250);
    }
  }

  async function ensureTimeEventsVisible() {
    await waitForSapUi();
    clickTimeEventsTab();
    for (let i = 0; i < 60; i++) {
      if (hasTimeEventsTable()) return;
      await sleep(300);
      clickTimeEventsTab();
    }
    throw new Error('Auswertung/Time Events Tabelle nicht gefunden. SAP wurde geöffnet, aber der Tab konnte nicht automatisch aktiviert werden. Bitte einmal manuell auf „Auswertung“ bzw. „Time events“ wechseln und erneut Sync klicken.');
  }

  function ddmmyyyyToIso(date) {
    const m = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  function timeToMinutes(time) {
    const m = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function nowMinutes() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }

  function parseEventsFromDom() {
    const rows = [...document.querySelectorAll('tr, .sapMListTblRow')];
    const events = [];
    for (const row of rows) {
      const rawCells = [...row.querySelectorAll('td, .sapMListTblCell')].map(td => clean(td.innerText || td.textContent)).filter(Boolean);
      const rowText = clean(row.innerText || row.textContent);
      const cells = rawCells.length ? rawCells : rowText.split(/\n+/).map(clean).filter(Boolean);
      const dateText = cells.find(x => /^\d{2}\.\d{2}\.\d{4}$/.test(x)) || (rowText.match(/\b\d{2}\.\d{2}\.\d{4}\b/) || [])[0];
      const timeText = cells.find(x => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(x)) || (rowText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
      const desc = cells.find(x => /^(Clock-(in|out)|Kommen|Gehen)$/i.test(x)) ||
        ((rowText.match(/Clock-in|Clock-out|Kommen|Gehen/i) || [])[0]);
      const type = cells.find(x => /^P\d+$/i.test(x)) || ((rowText.match(/\bP\d+\b/i) || [])[0]) || '';
      if (!dateText || !timeText || (!desc && !type)) continue;
      const reasonText = rowText;
      const isHo = /Teleworking|Home\s*Office|Homeoffice|Telearbeit|HO\b/i.test(reasonText);
      const iso = ddmmyyyyToIso(dateText);
      const minutes = timeToMinutes(timeText);
      if (!iso || minutes == null) continue;
      const description = desc || (/^P10$/i.test(type) ? 'Clock-in' : /^P20$/i.test(type) ? 'Clock-out' : '');
      if (!description) continue;
      events.push({ date: iso, type, description, time: minutes, timeText, reason: isHo ? 'Teleworking' : '', location: isHo ? 'HO' : 'FIRMA' });
    }
    const seen = new Set();
    return events.filter(e => {
      const key = `${e.date}|${e.description}|${e.type}|${e.time}|${e.reason}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  function pairEvents(events) {
    const warnings = [];
    const blocks = [];
    const grouped = {};
    for (const e of events) (grouped[e.date] ||= []).push(e);
    for (const date of Object.keys(grouped)) {
      const arr = grouped[date].sort((a, b) => a.time - b.time || a.description.localeCompare(b.description));
      let open = null;
      for (const ev of arr) {
        const isIn = /Clock-in|Kommen/i.test(ev.description) || /^P10$/i.test(ev.type);
        const isOut = /Clock-out|Gehen/i.test(ev.description) || /^P20$/i.test(ev.type);
        if (isIn) {
          if (open) {
            if (date === todayIso()) {
              const end = Math.min(nowMinutes(), ev.time);
              if (end > open.time) blocks.push({ date, start: open.time, end, location: open.location, open: true });
            } else warnings.push(`${date}: Clock-in ${open.timeText} ohne Clock-out übersprungen.`);
          }
          open = ev;
        } else if (isOut) {
          if (!open) { warnings.push(`${date}: Clock-out ${ev.timeText} ohne vorherigen Clock-in ignoriert.`); continue; }
          const location = open.location === 'HO' || ev.location === 'HO' ? 'HO' : 'FIRMA';
          if (ev.time > open.time) blocks.push({ date, start: open.time, end: ev.time, location, open: false });
          else warnings.push(`${date}: Clock-out ${ev.timeText} liegt vor Clock-in ${open.timeText}.`);
          open = null;
        }
      }
      if (open) {
        if (date === todayIso()) {
          const end = Math.max(open.time + 5, nowMinutes());
          blocks.push({ date, start: open.time, end, location: open.location, open: true });
          warnings.push(`${date}: aktuelle offene Stempelung wurde bis „jetzt“ importiert. Für Aktualisierung später erneut synchronisieren.`);
        } else warnings.push(`${date}: Clock-in ${open.timeText} ohne Clock-out übersprungen.`);
      }
    }
    return { blocks, warnings };
  }

  async function extract() {
    await ensureTimeEventsVisible();
    const events = parseEventsFromDom();
    const result = pairEvents(events);
    return { events, blocks: result.blocks, warnings: result.warnings, extractedAt: new Date().toISOString(), sourceUrl: location.href };
  }

  // ── Abwesenheits-/Anspruchsseite (#LeaveRequest-manage): verbrauchte Telearbeit + GLZ-Saldo ──
  function firstNumber(text) {
    const m = clean(text).match(/(\d+(?:[.,]\d+)?)/);
    return m ? m[1] : null;
  }
  function readLeaveOnce() {
    const containers = [...document.querySelectorAll('table, .sapMList, .sapMTable, [role="table"], .sapUiTable')];
    let tele = null, teleRaw = null, glz = null;
    for (const t of containers) {
      const heads = [...t.querySelectorAll('th, .sapMListTblHeaderCell, [role="columnheader"], .sapUiTableColHdr, .sapUiTableHeaderCell')].map(h => norm(h.textContent));
      const vi = heads.findIndex(h => h.includes('verbraucht'));
      const rows = [...t.querySelectorAll('tbody tr, li.sapMListTblRow, .sapMListTblRow, .sapUiTableRow')];
      for (const r of rows) {
        const cells = [...r.querySelectorAll('td, .sapMListTblCell, .sapUiTableCell')];
        if (!cells.length) continue;
        const rowText = norm(r.textContent);
        if (/telew|telearbeit/.test(rowText) && /jahr|year/.test(rowText) && tele == null) {
          // 1. Bevorzugt: Zelle über stabile SAP-Spalten-ID finden ("usedEntitlementCol" = Verbraucht).
          //    Sprach- und positionsunabhängig, funktioniert bei jedem Benutzer gleich.
          let cell = cells.find(c => /usedEntitlementCol/i.test(c.getAttribute('data-sap-ui-column') || c.getAttribute('headers') || ''));
          // 2. Fallback: Verbraucht-Spalte über Header-Index (wenn Spalten sauber ausgerichtet).
          // 3. Letzter Fallback: zweitletzte *echte* Zelle (Deko-Zellen ohne Inhalt ignorieren).
          if (!cell) {
            const real = cells.filter(c => clean(c.textContent));
            if (vi !== -1 && cells.length === heads.length) cell = cells[vi];
            else cell = real.length >= 2 ? real[real.length - 2] : real[real.length - 1];
          }
          const raw = cell ? clean(cell.textContent) : '';
          const num = firstNumber(raw);
          if (num != null) { tele = parseFloat(num.replace(',', '.')); teleRaw = raw; }
        }
        if ((/glz|gleitzeit|flextime|flex.?time/.test(rowText)) && glz == null) {
          // 1. Bevorzugt: Wert über stabile SAP-Spalten-ID ("availableEntitlementCol" = Anspruch/Saldo).
          const gCell = cells.find(c => /availableEntitlementCol/i.test(c.getAttribute('data-sap-ui-column') || c.getAttribute('headers') || ''));
          let m = gCell ? clean(gCell.textContent).match(/(-?\d+(?:[.,]\d+)?)/) : null;
          // 2. Fallback: Zahl vor "Stunden"/"hours" im Zeilentext (auch negativ, auch Englisch).
          if (!m) m = clean(r.textContent).match(/(-?\d+(?:[.,]\d+)?)\s*(?:Stunden|Std\.?|hours?|h)\b/i);
          if (m) glz = m[1].replace(',', '.');
        }
      }
    }
    if (tele == null && glz == null) return null;
    return { teleworkConsumed: tele, teleworkRaw: teleRaw, glz };
  }
  async function extractLeave() {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const found = readLeaveOnce();
      if (found && found.teleworkConsumed != null) return { ...found, sourceUrl: location.href };
      await sleep(400);
    }
    const last = readLeaveOnce() || {};
    return { ...last, sourceUrl: location.href };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;
    if (message.type === 'KOMBI_EXTRACT_EVENTS') {
      extract().then(sendResponse).catch(error => sendResponse({ events: [], blocks: [], warnings: [error.message || String(error)], error: error.message || String(error), extractedAt: new Date().toISOString(), sourceUrl: location.href }));
      return true;
    }
    if (message.type === 'KOMBI_EXTRACT_LEAVE') {
      extractLeave().then(sendResponse).catch(error => sendResponse({ teleworkConsumed: null, glz: null, error: error.message || String(error), sourceUrl: location.href }));
      return true;
    }
  });
})();
