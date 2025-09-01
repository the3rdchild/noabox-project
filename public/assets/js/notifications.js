(function () {
    // ---- CONFIG (can be overridden via window.NOTIFICATIONS_CONFIG before this script loads) ----
    const DEFAULTS = {
      POLL_SECONDS: 60,
      LOCATIONS_JSON: '../assets/data/locations.json',
      GVIZ_RANGE: 'A:Z',
  
      // thresholds (units consistent with your data)
      THRESHOLDS: {
        wind_kmh: { warning: 30, danger: 50 },
        rainfall_mm: { warning: 10, danger: 50 },
        // water temp: low/high warnings and dangers
        water_temp: { low_warning: 24, low_danger: 20, high_warning: 32, high_danger: 34 },
        // tss is sensor volts / proxy. These must be tuned to real sensor calibration.
        tss: { warning: 100, danger: 200 }
      },
  
      MAX_ITEMS: 6 // max items to show in dropdown
    };
  
    const cfg = Object.assign({}, DEFAULTS, window.NOTIFICATIONS_CONFIG || {});
    cfg.THRESHOLDS = Object.assign({}, DEFAULTS.THRESHOLDS, (window.NOTIFICATIONS_CONFIG && window.NOTIFICATIONS_CONFIG.THRESHOLDS) || {});
  
    // ---- helpers ----
    function todayDateString() { return new Date().toISOString().slice(0,10); }
    function resolveSheetNameFromMapping(mapping) {
      if (!mapping) return `data_${todayDateString()}`;
      const mapped = mapping.sheetName || '';
      if (mapped && mapped.includes('{date}')) return mapped.replace('{date}', todayDateString());
      if (mapped) return mapped;
      return `data_${todayDateString()}`;
    }
  
    async function fetchJsonNoStore(url) {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return r.json();
    }
  
    // Parse GViz text (same approach as graph-fetch)
    function parseGvizText(text) {
      const m = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)\s*;?$/);
      if (!m || !m[1]) throw new Error('Unexpected GViz response');
      return JSON.parse(m[1]);
    }
  
    function tableToRows(table) {
      if (!table || !Array.isArray(table.cols)) return [];
      const headers = table.cols.map(c => (c.label || c.id || '').toString());
      const rows = (table.rows || []).map(r => {
        const obj = {};
        for (let i=0;i<headers.length;i++){
          const cell = r.c && r.c[i] ? r.c[i] : null;
          const val = cell ? (cell.v !== undefined && cell.v !== null ? cell.v : (cell.f !== undefined ? cell.f : null)) : null;
          obj[headers[i] || `col_${i}`] = val;
        }
        return obj;
      });
      return rows;
    }
  
    async function fetchSheetViaGviz(sheetId, sheetName, range = cfg.GVIZ_RANGE) {
      if (!sheetId) throw new Error('sheetId missing');
      const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&range=${encodeURIComponent(range)}&tqx=out:json`;
      const txt = await fetch(url, { cache: 'no-store' }).then(r => r.text());
      if (txt.trim().startsWith('<')) throw new Error('GViz returned HTML (sheet likely not public)');
      const parsed = parseGvizText(txt);
      const rows = tableToRows(parsed.table);
      return rows;
    }
  
    function normalizeKey(key) {
      if (key === undefined || key === null) return '';
      return String(key).trim().toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }
  
    // pick best field from row
    function pickField(row, candidates) {
      if (!row || !candidates) return null;
      for (const cand of candidates) {
        const norm = normalizeKey(cand);
        const key = Object.keys(row).find(k => normalizeKey(k) === norm);
        if (key) return row[key];
      }
      // fallback substring match
      const lowcands = candidates.map(c => normalizeKey(c));
      for (const k of Object.keys(row)) {
        const nk = normalizeKey(k);
        for (const lc of lowcands) {
          if (nk.includes(lc) || lc.includes(nk)) return row[k];
        }
      }
      return null;
    }
  
    function asNumberOrNull(v) {
      if (v === null || v === undefined || (typeof v === 'string' && String(v).trim()==='')) return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const s = String(v).replace(/,/g,'').trim();
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
  
    function formatTimeLocal(ts) {
    try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts || '');
        const day = d.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', day: '2-digit' });
        const mon = d.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', month: 'short' }); // e.g. "Aug"
        const time = d.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
        return `${day} ${mon}: ${time}`;
    } catch (e) {
        return String(ts || '');
    }
    }
  
    // ---- DOM helpers for notification UI ----
    function getDropdownContainer() {
      // find the dropdown-menu used for notifications (first occurrence)
      return document.querySelector('.nav-item.dropdown .dropdown-menu');
    }
  
    function clearDropdown() {
      const cont = getDropdownContainer();
      if (!cont) return;
      cont.innerHTML = ''; // we'll insert items
    }
  
    function createNotifListItem(level, title, message, timeText) {
      const iconMap = {
        danger: '../assets/img/notifications/danger.png',
        warning: '../assets/img/notifications/warning.png',
        info: '../assets/img/notifications/notification.png'
      };
      const img = iconMap[level] || iconMap.info;
      const li = document.createElement('li');
      li.className = 'mb-2';
      li.innerHTML = `
        <a class="dropdown-item border-radius-md" href="javascript:;">
          <div class="d-flex py-1">
            <div class="my-auto">
              <img src="${img}" class="avatar avatar-sm me-3" />
            </div>
            <div class="d-flex flex-column justify-content-center">
              <h6 class="text-sm font-weight-normal mb-1">
                <span class="font-weight-bold">${level === 'danger' ? 'Danger' : 'Warning'}</span> ${title}
              </h6>
              <p class="text-xs text-secondary mb-0">
                <i class="fa fa-clock me-1"></i>${timeText || ''}
              </p>
              <div class="text-xs text-muted mt-1">${message || ''}</div>
            </div>
          </div>
        </a>
      `;
      return li;
    }
  
    // small floating toast for danger
    function ensureToastContainer() {
      let c = document.getElementById('notif-toast-container');
      if (c) return c;
      c = document.createElement('div');
      c.id = 'notif-toast-container';
      Object.assign(c.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        pointerEvents: 'none'
      });
      document.body.appendChild(c);
      return c;
    }
  
    function showDangerToast(title, message) {
      const c = ensureToastContainer();
      const el = document.createElement('div');
      Object.assign(el.style, {
        background: 'linear-gradient(90deg,#ff5f6d,#ffc371)',
        color: '#111',
        padding: '12px 14px',
        borderRadius: '8px',
        minWidth: '260px',
        boxShadow: '0 8px 20px rgba(12,20,28,0.12)',
        pointerEvents: 'auto',
        display: 'flex',
        gap: '10px',
        alignItems: 'center'
      });
      el.innerHTML = `<img src="../assets/img/notifications/danger.png" style="width:36px;height:36px;border-radius:6px;object-fit:cover"><div style="flex:1"><strong>${title}</strong><div style="font-size:12px;color:rgba(0,0,0,0.7); margin-top:6px">${message}</div></div><button aria-label="close" style="background:transparent;border:0;font-size:14px;cursor:pointer">✕</button>`;
      c.appendChild(el);
      const btn = el.querySelector('button');
      const remove = () => { el.remove(); };
      btn.addEventListener('click', remove);
      setTimeout(remove, 9000);
    }
  
    // ---- evaluation logic: produce events for a row ----
    function evaluateRowForAlerts(location, row) {
      if (!row) return [];
      const events = [];
      // pick fields using common headers
      const wind = asNumberOrNull(pickField(row, ['Wind Speed (km/h)','Wind Speed','wind_speed','wind speed','wind']));
      const rain = asNumberOrNull(pickField(row, ['Rainfall (mm)','Rainfall','rainfall','rain','Rain(mm)']));
      const waterTemp = asNumberOrNull(pickField(row, ['Water Temp (C)','Water Temp','water_temp','water temp','WaterTemp']));
      const tss = asNumberOrNull(pickField(row, ['TSS (V)','TSS','tss','turbidity','tss_v']));
  
      const tsRaw = pickField(row, ['Timestamp','timestamp','time','date','cachedAt']) || row.Timestamp || row.timestamp || null;
      const timeText = formatTimeLocal(tsRaw);
  
      // WIND
      if (wind !== null) {
        if (wind >= cfg.THRESHOLDS.wind_kmh.danger) events.push({ level: 'danger', title: `${location.name}: Wind`, message: `Wind speed ${wind} km/h (>= ${cfg.THRESHOLDS.wind_kmh.danger})`, timeText, param: 'wind' });
        else if (wind >= cfg.THRESHOLDS.wind_kmh.warning) events.push({ level: 'warning', title: `${location.name}: Wind`, message: `Wind speed ${wind} km/h (>= ${cfg.THRESHOLDS.wind_kmh.warning})`, timeText, param: 'wind' });
      }
  
      // RAIN
      if (rain !== null) {
        if (rain >= cfg.THRESHOLDS.rainfall_mm.danger) events.push({ level: 'danger', title: `${location.name}: Rainfall`, message: `Rainfall ${rain} mm (>= ${cfg.THRESHOLDS.rainfall_mm.danger})`, timeText, param: 'rain' });
        else if (rain >= cfg.THRESHOLDS.rainfall_mm.warning) events.push({ level: 'warning', title: `${location.name}: Rainfall`, message: `Rainfall ${rain} mm (>= ${cfg.THRESHOLDS.rainfall_mm.warning})`, timeText, param: 'rain' });
      }
  
      // WATER TEMP
      if (waterTemp !== null) {
        if (waterTemp <= cfg.THRESHOLDS.water_temp.low_danger || waterTemp >= cfg.THRESHOLDS.water_temp.high_danger) {
          events.push({ level: 'danger', title: `${location.name}: Water Temp`, message: `Water Temp ${waterTemp}°C (critical)`, timeText, param: 'water_temp' });
        } else if (waterTemp <= cfg.THRESHOLDS.water_temp.low_warning || waterTemp >= cfg.THRESHOLDS.water_temp.high_warning) {
          events.push({ level: 'warning', title: `${location.name}: Water Temp`, message: `Water Temp ${waterTemp}°C (threshold)`, timeText, param: 'water_temp' });
        }
      }
  
      // TSS
      if (tss !== null) {
        if (tss >= cfg.THRESHOLDS.tss.danger) events.push({ level: 'danger', title: `${location.name}: TSS`, message: `TSS ${tss} (>= ${cfg.THRESHOLDS.tss.danger})`, timeText, param: 'tss' });
        else if (tss >= cfg.THRESHOLDS.tss.warning) events.push({ level: 'warning', title: `${location.name}: TSS`, message: `TSS ${tss} (>= ${cfg.THRESHOLDS.tss.warning})`, timeText, param: 'tss' });
      }
  
      return events;
    }
  
    // ---- state to avoid duplicates ----
    const lastFired = {}; // map "locationId:param" -> timestamp string
  
    // ---- main: fetch all locations, evaluate, render ----
    async function loadLocationsMap() {
      try {
        const locs = await fetchJsonNoStore(cfg.LOCATIONS_JSON);
        return Array.isArray(locs) ? locs : [];
      } catch(e) {
        console.warn('notifications: failed load locations.json', e);
        return [];
      }
    }
  
    async function evaluateAllOnce() {
      const locs = await loadLocationsMap();
      if (!locs || !locs.length) return;
  
      const dropdown = getDropdownContainer();
      if (!dropdown) {
        console.warn('notifications: dropdown container not found');
      }
  
      const allEvents = [];
  
      // evaluate each location sequentially (could be parallel but keep simple)
      for (const loc of locs) {
        const sheetId = loc.sheetId || loc.sheetId || null;
        const sheetName = resolveSheetNameFromMapping(loc);
        let rows = null;
        try {
          rows = await fetchSheetViaGviz(sheetId, sheetName, cfg.GVIZ_RANGE);
        } catch (e) {
          // fallback: try /data/{locationId}/latest.json or daily files
          try {
            const latestPath = `/data/${encodeURIComponent(loc.locationId)}/latest.json`;
            const latest = await fetch(latestPath, { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
            if (latest && latest.sheetName) {
              const sheetFile = `/data/${encodeURIComponent(loc.locationId)}/${encodeURIComponent(latest.sheetName)}.json`;
              const r = await fetch(sheetFile, { cache: 'no-store' });
              if (r.ok) rows = await r.json();
            }
          } catch (ee) {
            // ignore
          }
        }
  
        if (!rows || !Array.isArray(rows) || rows.length === 0) continue;
        const lastRow = rows[rows.length - 1];
        const events = evaluateRowForAlerts(loc, lastRow);
        // dedupe and collect
        for (const ev of events) {
          const key = `${loc.locationId}:${ev.param}:${ev.level}`;
          const last = lastFired[key];
          const nowKeyTime = String(ev.timeText || Date.now());
          // simple dedupe: only fire again if timeText changed
          if (last !== nowKeyTime) {
            lastFired[key] = nowKeyTime;
            allEvents.push(ev);
          }
        }
      } // end for locations
  
      // render top N items in dropdown (most recent first)
      if (dropdown) {
        // clear and append
        dropdown.innerHTML = '';
        const sorted = allEvents.slice().sort((a,b) => (a.timeText < b.timeText ? 1 : -1)).slice(0, cfg.MAX_ITEMS);
        if (sorted.length === 0) {
          // show "no events"
          const li = document.createElement('li');
          li.className = 'mb-2';
          li.innerHTML = `<div class="dropdown-item border-radius-md text-center text-muted small">No alerts</div>`;
          dropdown.appendChild(li);
        } else {
          for (const ev of sorted) {
            const li = createNotifListItem(ev.level, ev.title, ev.message, ev.timeText);
            dropdown.appendChild(li);
          }
        }
      }
  
      // show toast for danger events (show unique ones)
      for (const ev of allEvents.filter(e=> e.level==='danger')) {
        try { showDangerToast(ev.title, ev.message); } catch(e){ }
      }
    }
  
    // ---- init + polling ----
    let pollTimer = null;
    async function init() {
      // run once now
      try { await evaluateAllOnce(); } catch(e){ console.warn('notifications init err', e); }
      // schedule poll
      const secs = parseInt((cfg.POLL_SECONDS || 60), 10) || 60;
      pollTimer = setInterval(() => { evaluateAllOnce().catch(e => console.warn('notif poll err', e)); }, secs*1000);
      // expose API
      window.NOTIFICATIONS_API = {
        cfg,
        evaluateAllOnce,
        stop: () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
      };
    }
  
    // start when DOM ready
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  
  })();
  