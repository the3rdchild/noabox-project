/* graph-fetch.js
   GViz (history only) + MQTT (cards only)
   - Expects window.chart1/chart2/chart3 to exist (created in graph.html)
   - Expects window.CLIMBOX_CONFIG override available before load (optional)
   - Reads sheetId from CLIMBOX_CONFIG.SHEET_ID or from locations.json mapping
*/
(() => {
  // minimal built-in defaults - will be merged with external config.json and window.CLIMBOX_CONFIG
  const DEFAULTS = {
    EXTERNAL_CONFIG_URL: '../assets/js/config.json',
    LOCATION_ID: 'pulau_komodo',
    HISTORY_POINTS: 20,
    LOCATIONS_JSON: '../assets/data/locations.json',
    GVIZ_RANGE: 'A:Z',
    SHEET_NAME_TOKEN_DATE: '{date}',
    CACHE_PREFIX: 'climbox_cache',
    KEYS: { /* fallback empty - will be merged from external config */ },
    FIELD_ALIASES: {},
    SENSOR_GROUPS: {},
    MQTT: {
      MQTT_WS: '',
      MQTT_USERNAME: '',
      MQTT_PASSWORD: '',
      MQTT_TOPIC_BASE: 'climbox',
      MQTT_SUBSCRIBE_WILDCARD: true,
      MQTT_RECONNECT_PERIOD_MS: 5000
    }
  };

  // deep merge utility (simple)
  function deepMerge(target, src) {
    if (!src) return target;
    for (const k of Object.keys(src)) {
      const sv = src[k];
      const tv = target[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
        target[k] = deepMerge(Object.assign({}, tv), sv);
      } else {
        target[k] = sv;
      }
    }
    return target;
  }

  // Start with defaults
  let cfg = Object.assign({}, DEFAULTS);

  // ---------- helpers ----------
  function normalizeKey(key) {
    if (key === undefined || key === null) return '';
    return String(key).trim().toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function todayDateString() {
    return new Date().toISOString().slice(0,10);
  }

  function resolveSheetNameFromMapping(mapping, explicit) {
    if (explicit && String(explicit).trim()) {
      const s = String(explicit).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `data_${s}`;
      return s;
    }
    const mapped = mapping && mapping.sheetName ? String(mapping.sheetName) : '';
    if (mapped.includes(cfg.SHEET_NAME_TOKEN_DATE)) {
      return mapped.replace(cfg.SHEET_NAME_TOKEN_DATE, todayDateString());
    }
    if (/^data_\d{4}-\d{2}-\d{2}$/.test(mapped)) {
      return `data_${todayDateString()}`;
    }
    return mapped || `data_${todayDateString()}`;
  }

  // fetch text with no-store
  async function fetchTextNoStore(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`fetch ${url} failed ${resp.status}`);
    return resp.text();
  }

  // attempt to load external config.json and merge
  async function loadExternalConfig() {
    const url = (window.CLIMBOX_CONFIG && window.CLIMBOX_CONFIG.EXTERNAL_CONFIG_URL) || cfg.EXTERNAL_CONFIG_URL;
    if (!url) return;
    try {
      const txt = await fetchTextNoStore(url);
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object') {
        deepMerge(cfg, parsed);
        // console.log('Loaded external config from', url);
      }
    } catch (e) {
      // console.warn('Failed to load external config', url, e && e.message ? e.message : e);
    }
  }

  // parse GViz wrapper -> JSON
  function parseGvizText(text) {
    const m = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)\s*;?$/);
    if (!m || !m[1]) throw new Error('Unexpected GViz response');
    return JSON.parse(m[1]);
  }

  // table -> array of objects
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

  // Try to find field value in a raw row using candidate labels
  function pickField(row, candidates) {
    if (!row || !candidates) return null;
    for (const cand of candidates) {
      const norm = normalizeKey(cand);
      const key = Object.keys(row).find(k => normalizeKey(k) === norm);
      if (key) return row[key];
    }
    // fallback: case-insensitive substring match
    const lowcands = candidates.map(c=>normalizeKey(c));
    for (const k of Object.keys(row)) {
      const nk = normalizeKey(k);
      for (const lc of lowcands) {
        if (nk.includes(lc) || lc.includes(nk)) return row[k];
      }
    }
    return null;
  }

  function asNumberOrNull(v) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim()==='')) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/,/g,'').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  
  function asBooleanOrNull(v) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    const s = String(v).toLowerCase().trim();
    if (s === 'on' || s === 'on ' || s === '1' || s === 'true') return true;
    if (s === 'off' || s === 'off ' || s === '0' || s === 'false') return false;
    return null;
  }


  // Get candidate labels for a canonical key: look into FIELD_ALIASES, KEYS mapping, fallback to the key itself
  function candidatesForCanonicalKey(canonicalKey) {
    const nk = normalizeKey(canonicalKey);
    let cands = [];
    // 1) explicit aliases in config
    if (cfg.FIELD_ALIASES && cfg.FIELD_ALIASES[nk] && Array.isArray(cfg.FIELD_ALIASES[nk])) {
      cands = cands.concat(cfg.FIELD_ALIASES[nk]);
    }
    // 2) KEYS mapping (chart keys)
    if (cfg.KEYS && cfg.KEYS[nk] && Array.isArray(cfg.KEYS[nk])) {
      cands = cands.concat(cfg.KEYS[nk]);
    }
    // 3) include human-readable variants of canonicalKey (replace _ with space & some common variants)
    if (cands.length === 0) {
      const readable = canonicalKey.replace(/_/g, ' ');
      cands.push(canonicalKey, readable);
    }
    // unique & preserve order
    const seen = new Set();
    return cands.filter(x => {
      const s = String(x||'').trim();
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Build grouped object (for cards) based on SENSOR_GROUPS mapping (now in cfg)
  function buildGroupForRow(rawRow) {
    const flat = {};
    Object.keys(rawRow || {}).forEach(k => {
      flat[ normalizeKey(k) ] = rawRow[k];
    });
    const grouped = { timestamp: flat['timestamp'] || flat['time'] || flat['timestamp_iso'] || null, groups: {} };

    const mapping = cfg.SENSOR_GROUPS || {};
    for (const [gname, fields] of Object.entries(mapping)) {
      grouped.groups[gname] = {};
      for (const field of fields) {
        const nk = normalizeKey(field);
        const candidates = candidatesForCanonicalKey(field);
        // try pick from rawRow by candidate labels
        const valFromRow = pickField(rawRow, candidates);
        let val = (valFromRow !== undefined ? valFromRow : (flat[nk] !== undefined ? flat[nk] : null));
        if (val !== null && val !== '' && !Number.isNaN(Number(String(val).replace(/,/g,'')))) {
          val = Number(String(val).replace(/,/g,''));
        }
        grouped.groups[gname][nk] = val;
      }
    }
    return grouped;
  }

  // ---------- charts: prepare arrays ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function parseMaybeGvizDate(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim().startsWith('Date(')) {
      const m = /Date\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(v);
      if (m) {
        return new Date(
          Number(m[1]), Number(m[2]), Number(m[3]),
          Number(m[4]), Number(m[5]), Number(m[6] || 0)
        );
      }
    }
    if (v instanceof Date) {
      if (!isNaN(v.getTime())) return v;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
    try {
      const d = new Date(String(v));
      if (!isNaN(d.getTime())) return d;
    } catch(e){}
    try {
      const s = String(v).trim();
      const parts = s.split(' ');
      if (parts.length >= 1 && parts[0].includes('/')) {
        const dparts = parts[0].split('/');
        if (dparts.length === 3) {
          const month = parseInt(dparts[0], 10);
          const day = parseInt(dparts[1], 10);
          const year = parseInt(dparts[2], 10);
          const timePart = parts[1] || '00:00:00';
          const t = timePart.split(':').map(x => parseInt(x, 10) || 0);
          const dt = new Date(year, month - 1, day, t[0] || 0, t[1] || 0, t[2] || 0);
          if (!isNaN(dt.getTime())) return dt;
        }
      }
    } catch(e){}
    return null;
  }

  // New function to filter rows for numerical data for a given set of keys
  function filterNumericalRows(rows, keys, maxPoints) {
    if (!rows || !Array.isArray(rows)) return [];
    const filteredRows = rows.filter(r => {
        return keys.some(key => {
            const val = asNumberOrNull(pickField(r, [key]));
            return val !== null;
        });
    });
    return filteredRows.slice(-Math.max(1, maxPoints));
}
  
function prepareChartArraysFromRows(rows, maxPoints = 20) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // The logic for Chart 1 remains the same as it shows all historical data
  const slice_chart1 = rows.slice(-Math.max(1, maxPoints));
  const labels_chart1 = slice_chart1.map(r => {
    const rawTs = pickField(r, cfg.KEYS && cfg.KEYS.timestamp ? cfg.KEYS.timestamp : ['Timestamp','timestamp','time','date']);
    const dt = parseMaybeGvizDate(rawTs);
    if (dt) {
      return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }
    return '';
  });
  function pickByKeyCanonical(row, canonicalKey) {
    const nk = normalizeKey(canonicalKey);
    const candidates = [];
    if (cfg.FIELD_ALIASES && cfg.FIELD_ALIASES[nk]) candidates.push(...cfg.FIELD_ALIASES[nk]);
    if (cfg.KEYS && cfg.KEYS[nk]) candidates.push(...cfg.KEYS[nk]);
    if (candidates.length === 0) candidates.push(canonicalKey);
    return pickField(row, candidates);
  }
  const c1_hum = slice_chart1.map(r => asNumberOrNull(pickByKeyCanonical(r, 'humidity')));
  const c1_air = slice_chart1.map(r => asNumberOrNull(pickByKeyCanonical(r, 'air_temp')));


  // Filter for Chart 2
  const keys_chart2 = ['water_temp', 'tss', 'ph'];
  const filtered_chart2 = filterNumericalRows(rows, keys_chart2, 5);
  const labels_chart2 = filtered_chart2.map(r => {
    const rawTs = pickField(r, cfg.KEYS && cfg.KEYS.timestamp ? cfg.KEYS.timestamp : ['Timestamp','timestamp','time','date']);
    const dt = parseMaybeGvizDate(rawTs);
    if (dt) {
      return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }
    return '';
  });
  const c2_wt = filtered_chart2.map(r => asNumberOrNull(pickByKeyCanonical(r, 'water_temp')));
  const c2_tss = filtered_chart2.map(r => asNumberOrNull(pickByKeyCanonical(r, 'tss')));
  const c2_ph = filtered_chart2.map(r => asNumberOrNull(pickByKeyCanonical(r, 'ph')));

  // Filter for Chart 3
  const keys_chart3 = ['do', 'ec', 'tds'];
  const filtered_chart3 = filterNumericalRows(rows, keys_chart3, 5);
  const labels_chart3 = filtered_chart3.map(r => {
    const rawTs = pickField(r, cfg.KEYS && cfg.KEYS.timestamp ? cfg.KEYS.timestamp : ['Timestamp','timestamp','time','date']);
    const dt = parseMaybeGvizDate(rawTs);
    if (dt) {
      return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }
    return '';
  });
  const c3_do = filtered_chart3.map(r => asNumberOrNull(pickByKeyCanonical(r, 'do')));
  const c3_ec = filtered_chart3.map(r => asNumberOrNull(pickByKeyCanonical(r, 'ec')));
  const c3_tds = filtered_chart3.map(r => asNumberOrNull(pickByKeyCanonical(r, 'tds')));


  return {
    labels: labels_chart1,
    labels_chart1,
    chart1: [c1_hum, c1_air],
    labels_chart2,
    chart2: [c2_wt, c2_tss, c2_ph],
    labels_chart3,
    chart3: [c3_do, c3_ec, c3_tds]
  };
}


  // safe chart setter
  function safeSetChart(chart, labels, datasetArrays) {
    if (!chart || !chart.data) return;
    chart.data.labels = Array.isArray(labels) ? labels.slice() : [];
    datasetArrays.forEach((arr, idx) => {
      if (!chart.data.datasets[idx]) return;
      chart.data.datasets[idx].data = Array.isArray(arr) ? arr.slice() : [];
    });
    try { chart.update(); } catch(e){ 
      // console.warn('chart update failed', e); 
    }
  }

  // ---------- cards` rendering ----------
  function getTargetCards(){
    const container = document.querySelector('.container-fluid.py-4 .row.g-3');
    if(!container) return [];
    const cardsByAttr = Array.from(container.querySelectorAll('[data-group]'));
    if(cardsByAttr.length >= 6) return cardsByAttr;
    const cols = Array.from(container.children).filter(c => c.querySelector && c.querySelector('.card'));
    return cols.slice(0,6).map(col => col.querySelector('.card'));
  }

  function humanizeKey(k){ return String(k).replace(/_/g,' ').toUpperCase(); }
  function setSafeText(el, txt) {
    if (!el) return;
    el.textContent = (txt === null || txt === undefined || txt === '') ? '--' : String(txt);
  }
  function fmtNumber(v, unit) {
    if (v === null || v === undefined) return '--';
    if (typeof v === 'number') {
      const n = Math.round(v * 100) / 100;
      return (unit ? `${n}${unit}` : String(n));
    }
    const num = Number(String(v).replace(/,/g,''));
    if (!Number.isNaN(num)) {
      const n = Math.round(num * 100) / 100;
      return (unit ? `${n}${unit}` : String(n));
    }
    return String(v);
  }

  // helper: set arrow rotation based on water temperature
function setArrowFromWaterTempInCard(cardEl, waterTempValue) {
  try {
    // prefer arrow inside this card; fallback to global id
    let arrow = null;
    if (cardEl) arrow = cardEl.querySelector('#arrow-pointer');
    if (!arrow) arrow = document.getElementById('arrow-pointer');
    if (!arrow) return;

    const tVal = asNumberOrNull(waterTempValue);
    if (tVal === null) {
      arrow.setAttribute("transform", `rotate(0 21 21)`);
      return;
    }

    const min = (cfg && cfg.ARROW && cfg.ARROW.min !== undefined) ? Number(cfg.ARROW.min) : 20;
    const max = (cfg && cfg.ARROW && cfg.ARROW.max !== undefined) ? Number(cfg.ARROW.max) : 40;
    const clamped = Math.max(min, Math.min(max, tVal));
    const t = (clamped - min) / (max - min); // 0..1

    const startAngle = -89;
    const endAngle = 190;
    let angle = startAngle + t * (endAngle - startAngle);
    angle = ((angle + 180) % 360) - 180;

    arrow.setAttribute("transform", `rotate(${angle} 21 21)`);
  } catch (e) {
    // console.warn('setArrowFromWaterTempInCard error', e);
  }
}

  function renderGroupToCard(cardEl, groupName, groupData, timestamp, meta = {}) {
    if(!cardEl) return;

    const lastEls = Array.from(cardEl.querySelectorAll('.last-updated'));
    if (lastEls.length && timestamp) {
      lastEls.forEach(le => setSafeText(le, `Last data received: ${timestamp}`));
    }

    let listEl = cardEl.querySelector('.group-metrics');
    if(!listEl){
      listEl = document.createElement('div');
      listEl.className = 'group-metrics mt-3';
      const body = cardEl.querySelector('.card-body') || cardEl;
      body.appendChild(listEl);
    }
    listEl.innerHTML = '';
    const entries = Object.entries(groupData || {});
    const sorted = entries.sort((a,b) => {
      const an = (typeof a[1] === 'number') ? 0 : 1;
      const bn = (typeof b[1] === 'number') ? 0 : 1;
      return an - bn;
    });
    const values = {};
    entries.forEach(([k,v]) => { values[k] = v; });

    const group = (groupName || '').toLowerCase();

    // METEOROLOGI
    if (group === 'meteorologi') {
      const bigN = cardEl.querySelector('.big-n');
      const air = values[ normalizeKey('air_temp') ] ?? values[ normalizeKey('temp_udara') ];
      const windSpeed = values[ normalizeKey('wind_speed') ];
      setSafeText(bigN, fmtNumber(asNumberOrNull(air) ?? asNumberOrNull(windSpeed), '°C'));
      setSafeText(cardEl.querySelector('.field-surface-temp'), values[ normalizeKey('wind_direction') ] ?? '-');
      setSafeText(cardEl.querySelector('.field-historical-max'), fmtNumber(asNumberOrNull(windSpeed), ' km/h'));
      setSafeText(cardEl.querySelector('.field-note'), (values[ normalizeKey('humidity') ] ? `RH ${fmtNumber(asNumberOrNull(values[ normalizeKey('humidity') ]), '%')}` : '--'));

      let lastEl = cardEl.querySelector('.last-updated');
      if (!lastEl) {
        lastEl = document.createElement('div');
        lastEl.className = 'muted small last-updated';
        lastEl.style.marginTop = '8px';
        const body = cardEl.querySelector('.card-body') || cardEl;
        body.appendChild(lastEl);
      }
      if (timestamp) {
        let dt = null;
        try {
          if (typeof parseMaybeGvizDate === 'function') dt = parseMaybeGvizDate(timestamp);
          if (!dt) dt = new Date(timestamp);
        } catch (e) { dt = new Date(timestamp); }
        const tsText = (dt && !isNaN(dt.getTime())) ? dt.toLocaleString('id-ID') : String(timestamp);
        setSafeText(lastEl, `Last data received: ${tsText}`);
      }
    }

    // PRESIPITASI
    else if (group === 'presipitasi') {
      const big = cardEl.querySelector('.big-n');
      const alt = cardEl.querySelector('.field-alt');
      const rainfall = values[ normalizeKey('rainfall') ];
      const dist = values[ normalizeKey('distance') ];
      setSafeText(big, fmtNumber(asNumberOrNull(rainfall), ' mm'));
      setSafeText(alt, fmtNumber(asNumberOrNull(dist), ' cm'));
    }

    // KUALITAS FISIKA
    else if (group === 'kualitas_fisika') {
      const big = cardEl.querySelector('.big-n');
      const ecBig = cardEl.querySelector('.field-ec-big');
      const coordsEl = cardEl.querySelector('.field-coords');
      const last = cardEl.querySelector('.last-updated');

      const waterTemp = groupData[ normalizeKey('water_temp') ] ?? groupData[ normalizeKey('watertemp') ];
      const ec = groupData[ normalizeKey('ec') ] ?? groupData[ normalizeKey('ec_ms_cm') ];
      const lat = groupData[ normalizeKey('latitude') ];
      const lon = groupData[ normalizeKey('longitude') ];

      setSafeText(big, fmtNumber(asNumberOrNull(waterTemp), '°C'));
      if (ecBig) setSafeText(ecBig, fmtNumber(asNumberOrNull(ec), ''));

      // ADD THIS LINE (call arrow updater)
      setArrowFromWaterTempInCard(cardEl, waterTemp);

      if (coordsEl) {
        const latTxt = (lat === undefined || lat === null || lat === '') ? '-' : String(lat);
        const lonTxt = (lon === undefined || lon === null || lon === '') ? '-' : String(lon);
        setSafeText(coordsEl, `Lat: ${latTxt}, Lon: ${lonTxt}`);
      }
      if (last && timestamp) {
        setSafeText(last, `Last data received: ${timestamp}`);
      }
    }


    // KUALITAS KIMIA DASAR
    else if (group === 'kualitas_kimia_dasar') {
      const big = cardEl.querySelector('.big-n');
      const detailA = cardEl.querySelector('.field-detail-a');
      const tds = values[ normalizeKey('tds') ];
      const ph = values[ normalizeKey('ph') ];
      setSafeText(big, fmtNumber(asNumberOrNull(tds), ' ppm'));
      setSafeText(detailA, fmtNumber(asNumberOrNull(ph), ''));
      listEl.innerHTML = '';
      [['pH', ph], ['TDS', tds]].forEach(([k,v])=>{
        const row = document.createElement('div');
        row.className = 'd-flex justify-content-between';
        row.innerHTML = `<div class="muted small">${k}</div><div class="fw-bold small">${v===null||v===undefined?'-':fmtNumber(asNumberOrNull(v), (k==='pH'?'':' ppm'))}</div>`;
        listEl.appendChild(row);
      });
    }

    // KUALITAS KIMIA LANJUT
    else if (group === 'kualitas_kimia_lanjut') {
      const primaryEl = cardEl.querySelector('.field-primary') || cardEl.querySelector('.big-n');
      const secondaryEl = cardEl.querySelector('.field-secondary');
      const last = cardEl.querySelector('.last-updated');

      const doVal = groupData[ normalizeKey('do') ];
      const pump1 = groupData[ normalizeKey('pompa_air_laut') ] ?? groupData[ normalizeKey('pompa_laut') ];
      const pump2 = groupData[ normalizeKey('pompa_bilas') ];

      setSafeText(primaryEl, fmtNumber(asNumberOrNull(doVal), ' mg/L'));

      const pumps = [];
      if (pump1 !== undefined && pump1 !== null && String(pump1).trim() !== '') pumps.push(`Pompa Laut: ${pump1}`);
      if (pump2 !== undefined && pump2 !== null && String(pump2).trim() !== '') pumps.push(`Pompa Bilas: ${pump2}`);
      setSafeText(secondaryEl, pumps.length ? pumps.join(' ') : '--');

      const gm = cardEl.querySelector('.group-metrics');
      if (gm) { gm.innerHTML = ''; gm.style.display = 'none'; }

      if (last && timestamp) {
        setSafeText(last, `Last data received: ${timestamp}`);
      }
    }

    // KUALITAS TURBIDITAS
    else if (group === 'kualitas_turbiditas') {
      const big = cardEl.querySelector('.big-n');
      const fieldDepth = cardEl.querySelector('.field-depth');
      const tss = values[ normalizeKey('tss') ];
      setSafeText(big, fmtNumber(asNumberOrNull(tss), ''));
      setSafeText(fieldDepth, fmtNumber(asNumberOrNull(tss), ''));
    }

    // Generic fallback
    if (!group) {
      listEl.innerHTML = '';
      entries.slice(0,4).forEach(([k,v])=>{
        const row = document.createElement('div');
        row.className = 'd-flex justify-content-between';
        row.innerHTML = `<div class="muted small">${k}</div><div class="fw-bold small">${v===null||v===undefined?'-':v}</div>`;
        listEl.appendChild(row);
      });
    }
  }

  function processRowsAndRenderCards(rows, meta = {}) {
    if (!rows || !Array.isArray(rows) || rows.length === 0) return;
    const lastRow = rows[rows.length - 1];

    const flat = {};
    Object.keys(lastRow || {}).forEach(k => {
      flat[ normalizeKey(k) ] = lastRow[k];
    });

    const grouped = { timestamp: pickField(lastRow, (cfg.KEYS && cfg.KEYS.timestamp) ? cfg.KEYS.timestamp : ['Timestamp','timestamp','time','date']) || (lastRow.Timestamp||lastRow.timestamp||null), groups: {} };
    const mapping = cfg.SENSOR_GROUPS || {};
    for (const [gname, fields] of Object.entries(mapping)) {
      grouped.groups[gname] = {};
      for (const field of fields) {
        const nk = normalizeKey(field);
        const candidates = candidatesForCanonicalKey(field);
        const valFromRow = pickField(lastRow, candidates);
        const val = (valFromRow !== undefined ? valFromRow : (flat[nk] !== undefined ? flat[nk] : null));
        grouped.groups[gname][nk] = (val !== null && val !== '' && !Number.isNaN(Number(String(val).replace(/,/g,'')))) ? Number(String(val).replace(/,/g,'')) : val;
      }
    }

    const order = ['meteorologi','presipitasi','kualitas_fisika','kualitas_kimia_dasar','kualitas_kimia_lanjut','kualitas_turbiditas'];
    order.forEach((grpName) => {
      const cardEl = document.querySelector(`[data-group="${grpName}"]`);
      if (cardEl) {
        try {
          renderGroupToCard(cardEl, grpName, grouped.groups[grpName] || {}, grouped.timestamp, meta);
        } catch (e) {
          // console.warn('renderGroupToCard error', grpName, e);
        }
      }
    });

    try {
      localStorage.setItem(`${cfg.CACHE_PREFIX}_sensor_${cfg.LOCATION_ID}`, JSON.stringify({
        fetchedAt: new Date().toISOString(),
        lastTimestamp: grouped.timestamp,
        raw: rows,
        grouped
      }));
    } catch(e){}
  }

  // ---------- GViz fetch helper ----------
  async function fetchSheetViaGviz(sheetId, sheetName, range=cfg.GVIZ_RANGE) {
    if (!sheetId) throw new Error('sheetId missing');
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&range=${encodeURIComponent(range)}&tqx=out:json`;
    const txt = await fetchTextNoStore(url);
    if (txt.trim().startsWith('<')) throw new Error('GViz returned HTML (sheet likely not public or blocked)');
    const parsed = parseGvizText(txt);
    const rows = tableToRows(parsed.table);
    return rows;
  }

  // ---------- MQTT (browser) for cards ----------
  const mqttScriptUrl = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
  let mqttClient = null, mqttConnected = false, mqttSubscribed = false;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        if (window.mqtt) return resolve();
        const t = setInterval(()=>{ if (window.mqtt){ clearInterval(t); resolve(); } }, 100);
        setTimeout(()=>{ if (!window.mqtt) reject(new Error('mqtt lib not available')); }, 4000);
        return;
      }
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => { if (window.mqtt) resolve(); else setTimeout(()=> window.mqtt ? resolve() : reject(new Error('mqtt lib missing after load')), 50); };
      s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }

  async function initMqttIfEnabled() {
    const mqttCfg = cfg.MQTT || {};
    if (!mqttCfg.MQTT_WS) {
      // console.log('MQTT disabled (MQTT_WS not provided)');
      return;
    }
    try {
      await loadScript(mqttScriptUrl);
    } catch(e) {
      // console.warn('Failed to load mqtt lib', e);
      return;
    }
    if (!window.mqtt) {
      // console.warn('mqtt lib not found after load');
      return;
    }
    const opts = {
      username: mqttCfg.MQTT_USERNAME || undefined,
      password: mqttCfg.MQTT_PASSWORD || undefined,
      reconnectPeriod: mqttCfg.MQTT_RECONNECT_PERIOD_MS || 5000,
      connectTimeout: 10*1000
    };
    try {
      mqttClient = window.mqtt.connect(mqttCfg.MQTT_WS, opts);
      mqttClient.on('connect', () => {
        mqttConnected = true;
        ensureSubscribe();
        // console.log('MQTT connected (browser)');
      });
      mqttClient.on('reconnect', () => {
        // console.log('MQTT reconnecting...');
      });
      mqttClient.on('close', () => {
        mqttConnected = false;
        mqttSubscribed = false;
        // console.log('MQTT closed');
      });
      mqttClient.on('offline', () => {
        mqttConnected = false;
      });
      mqttClient.on('error', (err) => {
        // console.warn('MQTT error', err && err.message ? err.message : err);
      });
      mqttClient.on('message', (topic, message) => {
        try {
          const txt = message.toString();
          let payload = null;
          try { payload = JSON.parse(txt); } catch(e) { 
            // console.warn('mqtt msg non-json', topic); 
          return; }
          let rows = null;
          if (Array.isArray(payload)) rows = payload;
          else if (payload && Array.isArray(payload.rows)) rows = payload.rows;
          else if (payload && Array.isArray(payload.data)) rows = payload.data;
          else if (payload && payload.Timestamp) rows = [payload];
          else if (payload && typeof payload === 'object' && Object.values(payload).some(v=>Array.isArray(v))) {
            for (const v of Object.values(payload)) if (Array.isArray(v)) { rows = v; break; }
          }
          if (!rows || !Array.isArray(rows) || rows.length === 0) { 
            // console.warn('MQTT message with no usable rows', topic); 
          return; }
          processRowsAndRenderCards(rows);
        } catch(e) { 
          // console.error('Error handling mqtt message', e); 
        }
      });
    } catch(e) {
      // console.warn('mqtt connect failed', e);
    }
  }

  function ensureSubscribe() {
    const mqttCfg = cfg.MQTT || {};
    if (!mqttClient || !mqttConnected || mqttSubscribed) return;
    const topic = mqttCfg.MQTT_SUBSCRIBE_WILDCARD ? `${mqttCfg.MQTT_TOPIC_BASE}/${cfg.LOCATION_ID}/#` : `${mqttCfg.MQTT_TOPIC_BASE}/${cfg.LOCATION_ID}/latest`;
    mqttClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) 
        console.warn('mqtt subscribe error', err);
      else { mqttSubscribed = true; 
        // console.log('Subscribed to', topic); 
      }
    });
  }

  // ---------- load locations map ----------
  async function loadLocationsMap() {
    try {
      const r = await fetch(cfg.LOCATIONS_JSON, { cache: 'no-store' });
      if (!r.ok) throw new Error('locations.json fetch failed');
      return await r.json();
    } catch(e) {
      console.warn('loadLocationsMap failed', e);
      return [];
    }
  }

  // ---------- main init ----------
  async function init() {
    // merge available overrides
    if (window.CLIMBOX_CONFIG) deepMerge(cfg, window.CLIMBOX_CONFIG);

    // try to load external config.json and merge (overrides DEFAULTS)
    await loadExternalConfig();

    // window.CLIMBOX_CONFIG has highest priority — merge again if present
    if (window.CLIMBOX_CONFIG) deepMerge(cfg, window.CLIMBOX_CONFIG);

    const urlParams = new URLSearchParams(window.location.search);
    const qloc = urlParams.get('location');
    cfg.LOCATION_ID = cfg.LOCATION_ID || qloc || 'climbox';

    const locs = await loadLocationsMap();
    const mapping = (locs || []).find(l => l.locationId === cfg.LOCATION_ID || l.id === cfg.LOCATION_ID) || null;
    const sheetId = cfg.SHEET_ID || (mapping && mapping.sheetId) || null;
    const sheetName = resolveSheetNameFromMapping(mapping, cfg.SHEET_NAME || null);

    if (sheetId) {
      try {
        const rows = await fetchSheetViaGviz(sheetId, sheetName, cfg.GVIZ_RANGE);
        const prepared = prepareChartArraysFromRows(rows, parseInt(cfg.HISTORY_POINTS || 7, 10));
        if (prepared) {
          safeSetChart(window.chart1, prepared.labels_chart1, prepared.chart1);
          safeSetChart(window.chart2, prepared.labels_chart2, prepared.chart2);
          safeSetChart(window.chart3, prepared.labels_chart3, prepared.chart3);
        } else {
          console.warn('No prepared data from GViz');
        }
        if (Array.isArray(rows) && rows.length) processRowsAndRenderCards(rows);
        // console.log('GViz loaded', { locationId: cfg.LOCATION_ID, sheetId, sheetName, rows: Array.isArray(rows)?rows.length:null });
      } catch (e) {
        console.warn('GViz fetch/render failed (history). Make sure sheet is public if you want GViz. Error:', e && e.message ? e.message : e);
      }
    } else {
      // console.warn('No sheetId available for GViz history (set window.CLIMBOX_CONFIG.SHEET_ID or add to locations.json)');
    }

    try {
      await initMqttIfEnabled();
    } catch(e){ console.warn('mqtt init err', e); }

    // console.log('graph-fetch initialized', { locationId: cfg.LOCATION_ID, cfgSummary: { mqtt: !!(cfg.MQTT && cfg.MQTT.MQTT_WS), groups: Object.keys(cfg.SENSOR_GROUPS || {}).length } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Expose debug API
  window.CLIMBOX_GRAPH_FETCH = Object.assign(window.CLIMBOX_GRAPH_FETCH || {}, {
    cfg,
    fetchSheetViaGviz,
    prepareChartArraysFromRows,
    processRowsAndRenderCards,
    mqttClient: () => mqttClient
  });
})();