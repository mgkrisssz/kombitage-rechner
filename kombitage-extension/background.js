const DEFAULT_SAP_URL = 'https://zkrcip010001.sap.intranet.zkw.at:44300/sap/bc/ui2/flp#ZHR_Virtuelles_Terminal-create';
const LEAVE_URL = 'https://zkrcip010001.sap.intranet.zkw.at:44300/sap/bc/ui2/flp#LeaveRequest-manage';
const SAP_ORIGIN_PATTERN = 'https://zkrcip010001.sap.intranet.zkw.at:44300/*';

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('kombi.html') });
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') finish();
    });
  });
}

async function ensureSapTab(sapUrl) {
  const url = sapUrl || DEFAULT_SAP_URL;
  const tabs = await chrome.tabs.query({ url: SAP_ORIGIN_PATTERN });
  let tab = tabs.find(t => (t.url || '').includes('#ZHR_Virtuelles_Terminal-create')) || tabs[0];
  let created = false;

  if (tab) {
    if (!(tab.url || '').includes('#ZHR_Virtuelles_Terminal-create')) {
      tab = await chrome.tabs.update(tab.id, { url, active: false });
    }
  } else {
    tab = await chrome.tabs.create({ url, active: false });
    created = true;
  }

  await waitForTabComplete(tab.id);
  await sleep(3500);
  return { tab, created };
}

async function extractFromSap(tabId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      if (attempt > 1) await sleep(2500);
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: 'KOMBI_EXTRACT_EVENTS' });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-sap.js'] });
        response = await chrome.tabs.sendMessage(tabId, { type: 'KOMBI_EXTRACT_EVENTS' });
      }
      if (response && response.error) throw new Error(response.error);
      if (response && (response.blocks?.length || response.events?.length)) return response;
      lastError = new Error('SAP wurde geöffnet, aber noch keine Stempeldaten gefunden. Wahrscheinlich ist eine Anmeldung oder Freigabe nötig.');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('SAP Sync fehlgeschlagen.');
}

async function extractLeaveFromSap(tabId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await sleep(2000);
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: 'KOMBI_EXTRACT_LEAVE' });
      } catch (_) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-sap.js'] });
        response = await chrome.tabs.sendMessage(tabId, { type: 'KOMBI_EXTRACT_LEAVE' });
      }
      if (response && (response.teleworkConsumed != null || response.glz != null)) return response;
    } catch (_) {}
  }
  return null;
}

async function readLeave(tabId) {
  await chrome.tabs.update(tabId, { url: LEAVE_URL, active: false });
  await waitForTabComplete(tabId);
  await sleep(3000);
  return extractLeaveFromSap(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'KOMBI_SAP_SYNC') return;

  (async () => {
    let tabInfo = null;
    try {
      tabInfo = await ensureSapTab(message.sapUrl || DEFAULT_SAP_URL);
      const data = await extractFromSap(tabInfo.tab.id);
      const sourceUrl = tabInfo.tab.url || message.sapUrl || DEFAULT_SAP_URL;
      // Danach kurz auf die Abwesenheits-/Anspruchsseite, um den offiziellen Telearbeit-Verbrauch + GLZ-Saldo zu lesen.
      try {
        data.leave = await readLeave(tabInfo.tab.id);
      } catch (leaveErr) {
        data.leaveError = leaveErr.message || String(leaveErr);
      }
      if (tabInfo.created) {
        try { await chrome.tabs.remove(tabInfo.tab.id); } catch (_) {}
      }
      sendResponse({ ok: true, data, tabClosed: tabInfo.created, sourceUrl });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message || String(error),
        tabId: tabInfo?.tab?.id,
        tabUrl: tabInfo?.tab?.url || message.sapUrl || DEFAULT_SAP_URL,
        createdTabKeptOpen: !!tabInfo?.created
      });
    }
  })();
  return true;
});
