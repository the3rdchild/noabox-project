(function () {
  const cfg = Object.assign({
    MQTT_WS: 'wss://test.mosquitto.org:8081/mqtt',
    MQTT_TOPIC_BASE: 'climbox',
    MQTT_SUBSCRIBE_WILDCARD: false,
    MQTT_RECONNECT_MS: 5000
  }, window.CLIMBOX_MAP_CONFIG || {});

  // ensure global locations array exists (map page defines it before loading this file)
  if (!Array.isArray(window.locations)) {
    window.locations = window.locations || [];
  }

  // -------------------- UI: list rendering --------------------
  function renderStaticLocationList() {
    const ul = document.getElementById('location-list');
    if (!ul) {
      // console.warn('map-live: #location-list not found in DOM');
      return;
    }
    ul.innerHTML = '';
    window.locations.forEach(loc => {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex justify-content-between align-items-center list-group-item-action';
      li.setAttribute('data-location-id', loc.locationId);
      li.innerHTML = `
        <div>
          <strong class="loc-title">${escapeHtml(String(loc.name || loc.locationId))}</strong><br>
          <small class="text-muted loc-sub">${escapeHtml(loc.country || '')}</small>
        </div>
        <div class="text-end" style="min-width:120px">
          <div class="small text-muted live-ts">--</div>
          <div class="small fw-bold live-summary">--</div>
        </div>
      `;
      // default click -> go to graph
      li.addEventListener('click', () => {
        // also update graph-link text for UX
        setGraphLink(loc.locationId, loc.name || loc.locationId);
        window.location.href = `/pages/graph.html?location=${encodeURIComponent(loc.locationId)}`;
      });
      ul.appendChild(li);
    });
  }

  // safe small html escape for inserted strings
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  function getListItemEl(locationId) {
    try {
      return document.querySelector(`#location-list [data-location-id="${CSS.escape(locationId)}"]`);
    } catch (e) {
      // older browsers
      return Array.from(document.querySelectorAll('#location-list [data-location-id]'))
        .find(el => el.getAttribute('data-location-id') === locationId);
    }
  }

  // -------------------- Live summary helpers --------------------
  function extractTempsFromRow(row) {
    if (!row || typeof row !== 'object') return { water: null, air: null };
    let water = null, air = null;
    const toNum = v => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim().replace(',', '.').replace(/[^\d\.\-]/g, '');
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    for (const key of Object.keys(row)) {
      const lk = key.toLowerCase();
      const raw = row[key];
      if (lk.includes('water') && lk.includes('temp')) {
        const n = toNum(raw); if (n !== null) water = n;
      } else if (lk.includes('sst') || (lk.includes('sea') && lk.includes('temp'))) {
        const n = toNum(raw); if (n !== null && water === null) water = n;
      } else if ((lk.includes('temp') && lk.includes('udara')) || lk.includes('temp_udara') || lk === 'temp') {
        const n = toNum(raw); if (n !== null) air = n;
      } else if (lk.includes('air') && lk.includes('temp')) {
        const n = toNum(raw); if (n !== null && air === null) air = n;
      }
      // fallback exact-ish
      if (water === null && (lk === 'water temp (c)' || lk === 'water_temp_c' || lk === 'water_temp')) {
        const n = toNum(raw); if (n !== null) water = n;
      }
      if (air === null && (lk === 'temp udara' || lk === 'temp_udara')) {
        const n = toNum(raw); if (n !== null) air = n;
      }
    }
    return { water, air };
  }

  // New helper: get selected location id from graph-link anchor (if set)
  function getSelectedLocationId() {
    try {
      const a = ensureGraphLinkEl();
      if (!a || !a.href) return null;
      const u = new URL(a.href, window.location.origin);
      return u.searchParams.get('location') || null;
    } catch (e) {
      return null;
    }
  }

  // -------------------- Chart1 integration --------------------
  // We'll create a chart instance named window.chart1 on the page canvas#chart (if present).
  // Provide updateChartFromRows(rows) to fill chart1 using the same mapping used in graph.html (water, humidity, air).
  let chartCreationTimer = null;

  function createChart1WhenReady() {
    // If a chart already exists, skip
    if (window.chart1) return;
    const canvas = document.getElementById('chart');
    if (!canvas) return;
    const tryCreate = () => {
      if (window.Chart && canvas.getContext) {
        try {
          const ctx = canvas.getContext('2d');
          const ch = new Chart(ctx, {
            type: 'line',
            data: {
              labels: [],
              datasets: [
                // { label: 'Water Temp (°C)', data: [], borderColor: 'blue', fill: false },
                { label: 'Humidity (%)', data: [], borderColor: 'green', fill: false },
                { label: 'Air Temp (°C)', data: [], borderColor: 'orange', fill: false }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: { title: { display: true, text: 'Temperature / Humidity' } },
                x: { title: { display: true, text: 'Time' } }
              }
            }
          });
          window.chart1 = ch;
          if (chartCreationTimer) { clearInterval(chartCreationTimer); chartCreationTimer = null; }
          // console.log('map-live: created chart1 (shared with graph.html)');
        } catch (e) {
          console.warn('map-live: Chart creation failed, will retry', e);
        }
      }
    };
    // immediate attempt
    tryCreate();
    // if Chart not yet loaded, poll for a short while
    if (!window.chart1 && !chartCreationTimer) {
      chartCreationTimer = setInterval(tryCreate, 200);
      // stop after 10 seconds
      setTimeout(() => {
        if (chartCreationTimer) { clearInterval(chartCreationTimer); chartCreationTimer = null; }
      }, 10000);
    }
  }

  function NumberOrNull(x) {
    if (x === null || x === undefined || x === '') return null;
    const n = Number(String(x).replace(/,/g,''));
    return Number.isNaN(n) ? null : n;
  }

  // rows: array-of-objects sorted ascending by timestamp (oldest -> newest)
  function updateChartFromRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    // take last up to 7 points (same logic as graph.html)
    const last = rows.slice(-7);
    const labels = last.map(r => (r.Timestamp || r.timestamp || r.time || r.cachedAt));
    // build arrays
    const waterTemp = last.map(r => {
      const v = r['Water Temp (C)'] ?? r['water_temp'] ?? r['water temp'] ?? r['WaterTemp'] ?? null;
      return v === null || v === '' ? null : Number(String(v).replace(/,/g,''));
    });
    const airTemp = last.map(r => {
      const v = r['Temp udara'] ?? r['Temp udara'] ?? r['temp udara'] ?? r['Air Temp'] ?? r['air_temp'] ?? null;
      return v === null || v === '' ? null : Number(String(v).replace(/,/g,''));
    });
    // attempt to find humidity in common keys
    const humidity = last.map(r => {
      const v = r['Humidity (%)'] ?? r['Humidity'] ?? r['humidity'] ?? r['hum'] ?? null;
      return v === null || v === '' ? null : Number(String(v).replace(/,/g,''));
    });

    if (window.chart1) {
      window.chart1.data.labels = labels;
      if (window.chart1.data.datasets[0]) window.chart1.data.datasets[0].data = waterTemp;
      if (window.chart1.data.datasets[1]) window.chart1.data.datasets[1].data = humidity;
      if (window.chart1.data.datasets[2]) window.chart1.data.datasets[2].data = airTemp;
      try { window.chart1.update(); } catch (e) { console.warn('map-live: chart1 update error', e); }
    }
  }

  // -------------------- MQTT --------------------
  const mqttScriptUrl = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
  let mqttClient = null;

  function loadMqttLib() {
    return new Promise((resolve, reject) => {
      if (window.mqtt) return resolve(window.mqtt);
      if (document.querySelector(`script[src="${mqttScriptUrl}"]`)) {
        const check = () => { if (window.mqtt) resolve(window.mqtt); else setTimeout(check, 100); };
        return check();
      }
      const s = document.createElement('script');
      s.src = mqttScriptUrl;
      s.async = true;
      s.onload = () => resolve(window.mqtt);
      s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }

  async function initMqtt() {
    if (!cfg.MQTT_WS) {
      console.log('map-live: MQTT disabled (MQTT_WS empty)');
      return;
    }
    try {
      await loadMqttLib();
    } catch (e) {
      console.warn('map-live: failed to load mqtt lib', e);
      return;
    }

    try {
      mqttClient = window.mqtt.connect(cfg.MQTT_WS, { reconnectPeriod: cfg.MQTT_RECONNECT_MS || 5000, connectTimeout: 10000 });

      mqttClient.on('connect', () => {
        // console.log('map-live: mqtt connected');
        if (cfg.MQTT_SUBSCRIBE_WILDCARD) {
          const wildcard = `${cfg.MQTT_TOPIC_BASE}/+/latest`;
          mqttClient.subscribe(wildcard, { qos: 1 }, (err) => {
            // if (err) console.warn('map-live subscribe wildcard error', err);
            // else console.log('map-live subscribed', wildcard);
          });
        } else {
          window.locations.forEach(loc => {
            const topic = `${cfg.MQTT_TOPIC_BASE}/${loc.locationId}/latest`;
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
              // if (err) console.warn('map-live subscribe err', topic, err);
              // else console.log('map-live subscribed', topic);
            });
          });
        }
      });

      mqttClient.on('message', (topic, message) => {
        try {
          const txt = message.toString();
          let payload = null;
          try { payload = JSON.parse(txt); } catch (e) { console.warn('map-live: invalid json mqtt msg', txt); return; }

          const parts = String(topic).split('/');
          const topicLoc = (parts.length >= 2) ? parts[1] : null;
          const locId = (payload && payload.locationId) ? payload.locationId : topicLoc;
          if (!locId) return;
          updateListLive(locId, payload);

          // store last MQTT payload per location so map popup can read latest live fields
          window.MAP_LIVE_LATEST = window.MAP_LIVE_LATEST || {};
          try { window.MAP_LIVE_LATEST[locId] = payload; } catch(e) { /* defensive */ }

          // If payload contains rows (or data array), and chart1 exists, update chart
          const rows = Array.isArray(payload.rows) ? payload.rows
                     : Array.isArray(payload.data) ? payload.data
                     : (Array.isArray(payload) ? payload : null);


          // Only update chart if the message is for the currently-selected location (UX)
          const selected = getSelectedLocationId();
          if (rows && window.chart1 && (!selected || selected === locId)) {
            try {
              // normalize timestamps & sort ascending (reuse simple approach)
              const normalized = (rows.map(r => Object.assign({}, r, {
                __tsDate: (() => {
                  const ts = r.Timestamp || r.timestamp || r.time || r.cachedAt || null;
                  const d = ts ? new Date(ts) : null;
                  return d && !isNaN(d.getTime()) ? d : null;
                })()
              })).filter(r => r.__tsDate).sort((a,b)=> a.__tsDate - b.__tsDate).map(r => {
                // keep original keys but prefer ISO-like timestamp in Timestamp for labels
                return Object.assign({}, r, { Timestamp: r.Timestamp || r.timestamp || r.time || r.cachedAt });
              }));
              updateChartFromRows(normalized);
            } catch (e) {
              console.warn('map-live: updateChartFromRows error', e);
            }
          }

        } catch (e) {
          console.warn('map-live mqtt message handler error', e);
        }
      });

      mqttClient.on('error', (e) => console.warn(' ', e)); //map-live mqtt error
      mqttClient.on('close', () => console.log(' ')); //map-live mqtt closed
    } catch (e) {
      console.warn('map-live initMqtt error', e);
    }
  }

  // -------------------- Graph link helper (clearer) --------------------
function ensureGraphLinkEl() {
  // 1) If already created before, return it
  let middle = document.getElementById('graph-link');
  if (middle) return middle;

  // 2) Try to detect a static wrapper: a div that contains 3 anchors with the expected texts
  const divs = Array.from(document.querySelectorAll('div'));
  for (const d of divs) {
    const anchors = Array.from(d.querySelectorAll('a'));
    if (anchors.length >= 3) {
      const left = (anchors[0].textContent || '').trim().toLowerCase();
      const mid  = (anchors[1].textContent || '').trim();
      const right = (anchors[2].textContent || '').trim().toLowerCase();
      if (left.startsWith('lihat data') && mid.toLowerCase().includes('pilih lokasi sensor') && right.startsWith('lebih lanjut')) {
        // use the middle anchor, assign id and style, return it
        const m = anchors[1];
        m.id = 'graph-link';
        m.style.color = '#0224e6';
        m.style.textDecoration = 'none';
        // ensure it has a safe href fallback
        if (!m.getAttribute('href')) m.href = '/pages/graph.html';
        return m;
      }
    }
  }

  // 3) If not found, try to find any anchor that contains '[Pilih Lokasi Sensor]' text
  const found = Array.from(document.querySelectorAll('a')).find(a => (a.textContent || '').toLowerCase().includes('pilih lokasi sensor'));
  if (found) {
    found.id = 'graph-link';
    found.style.color = '#0224e6';
    found.style.textDecoration = 'none';
    if (!found.getAttribute('href')) found.href = '/pages/graph.html';
    return found;
  }

  // 4) If still not found, reuse existing wrapper container if it exists (defensive)
  const existingWrapper = document.getElementById('graph-link-wrapper');
  if (existingWrapper) {
    const candidate = existingWrapper.querySelector('a') || existingWrapper.querySelector('#graph-link');
    if (candidate) { candidate.id = 'graph-link'; candidate.style.color = '#0224e6'; return candidate; }
  }

  // 5) Otherwise create the wrapper and anchors (same structure as your static markup)
  const wrapper = document.createElement('div');
  wrapper.id = 'graph-link-wrapper';
  wrapper.style.display = 'flex';
  wrapper.style.gap = '8px';
  wrapper.style.alignItems = 'center';
  wrapper.style.marginLeft = '20px';

  // Left anchor: "Lihat Data"
  const left = document.createElement('a');
  left.className = 'font-weight-bold';
  left.textContent = 'Lihat Data';
  left.href = '/pages/graph.html';
  left.href = 'javascript:void(0)';
  left.style.textDecoration = 'none';
  left.style.cursor = 'default';

  // Middle anchor: the dynamic location name (returned)
  middle = document.createElement('a');
  middle.className = 'font-weight-bold';
  middle.id = 'graph-link';
  middle.href = '/pages/graph.html';
  middle.textContent = '[Pilih Lokasi Sensor]';
  middle.style.color = '#0224e6';
  middle.style.textDecoration = 'none';

  // Right anchor: "Lebih Lanjut..."
  const right = document.createElement('a');
  right.className = 'font-weight-bold';
  right.textContent = 'Lebih Lanjut...';
  right.href = '/pages/graph.html';
  right.style.textDecoration = 'none';

  wrapper.appendChild(left);
  wrapper.appendChild(middle);
  wrapper.appendChild(right);

  const ul = document.getElementById('location-list');
  if (ul && ul.parentNode) {
    const container = document.createElement('div');
    container.style.marginBottom = '6px';
    container.appendChild(wrapper);
    ul.parentNode.insertBefore(container, ul);
  } else {
    document.body.appendChild(wrapper);
  }

  return middle;
}

// setGraphLink updates the middle anchor text + href (and keeps it dark blue)
function setGraphLink(locationId, displayName) {
  const a = ensureGraphLinkEl();

  // escapeHtml helper exists elsewhere in this file; fallback to basic string if absent
  const safeName = (typeof escapeHtml === 'function') ? escapeHtml(displayName || locationId) : String(displayName || locationId);

  a.href = `/pages/graph.html?location=${encodeURIComponent(locationId)}`;
  a.textContent = `[${safeName}]`;
  a.style.color = '#0224e6'; // keep dark blue
  a.style.textDecoration = 'none';
}


// setGraphLink updates the middle anchor text + href (and keeps it dark blue)
function setGraphLink(locationId, displayName) {
  const a = ensureGraphLinkEl();

  // use existing escapeHtml helper in file for safety
  const safeName = (typeof escapeHtml === 'function') ? escapeHtml(displayName || locationId) : String(displayName || locationId);

  a.href = `/pages/graph.html?location=${encodeURIComponent(locationId)}`;
  a.textContent = `[${safeName}]`;
  a.style.color = '#0224e6'; // ensure dark blue
}

// openGraph keeps previous behaviour (set link then navigate)
function openGraph(locationId) {
  const id = locationId || (window.locations && window.locations[0] && window.locations[0].locationId);
  if (!id) return;
  setGraphLink(id);
  window.location.href = `/pages/graph.html?location=${encodeURIComponent(id)}`;
}

  // -------------------- Public API (clear names) --------------------
  const MAP_API = {
    // Called when a marker/list item is clicked. Accepts location object.
    onMarkerClicked: function (loc) {
      try {
        setGraphLink(loc.locationId, loc.name || loc.displayName || loc.locationId);
        // do not auto-navigate; leave that to caller
      } catch (e) {
        console.warn('map-live onMarkerClicked error', e);
      }
    },
    // programmatically set the graph link text/href
    setGraphLink,
    // open graph page for a location
    openGraph,
    // expose mqtt client getter
    client: function () { return mqttClient; },
    // runtime config
    cfg,
    // new: allow external scripts to pass rows/data to fill shared chart1
    updateChartFromRows: function(rows) {
      updateChartFromRows(rows);
    },
    // convenience: create chart if not created yet
    ensureChart1: function() {
      createChart1WhenReady();
    }
  };

  // -------------------- Init --------------------
  document.addEventListener('DOMContentLoaded', () => {
    renderStaticLocationList();
    initMqtt().catch(e => console.warn('map-live mqtt init', e));
    // create chart1 if Chart.js already loaded (or wait for it)
    createChart1WhenReady();
    // attach API globally (clearer names)
    window.MAP_LIVE = Object.assign(window.MAP_LIVE || {}, MAP_API);
    // keep backwards compatibility if someone expected MAP_LIVE.onMarkerClicked via previous API
    // console.log('map-live: initialized, MAP_LIVE API:', Object.keys(MAP_API));
  });
})();
