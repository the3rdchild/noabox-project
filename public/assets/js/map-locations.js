(function(){
    // default config: override before loading script with window.CLIMBOX_MAP_CONFIG
    const cfg = Object.assign({
      LOCATIONS_ENDPOINT: '/locations',
      MQTT_WS: '', // set to 'wss://broker.emqx.io:8084/mqtt' if you want live mini-updates in map list
      MQTT_TOPIC_BASE: 'climbox',
      MQTT_SUBSCRIBE_LIVE: true,
      MQTT_RECONNECT_MS: 5000
    }, window.CLIMBOX_MAP_CONFIG || {});
  
    // Render list into #location-list
    async function loadAndRenderLocations() {
      try {
        const res = await fetch(cfg.LOCATIONS_ENDPOINT, { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load locations');
        const list = await res.json();
        const ul = document.getElementById('location-list');
        if (!ul) return;
        ul.innerHTML = '';
        list.forEach(loc => {
          const li = document.createElement('li');
          li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-start';
          li.setAttribute('data-location-id', loc.locationId);
          li.innerHTML = `<div>
              <strong class="loc-title">${loc.displayName || loc.locationId}</strong><br>
              <small class="loc-sub">${loc.country || ''}</small>
            </div>
            <div class="live-badges text-end">
              <div class="small muted live-ts">--</div>
              <div class="small live-summary">--</div>
            </div>`;
          li.addEventListener('click', () => {
            window.location.href = `/pages/graph.html?location=${encodeURIComponent(loc.locationId)}`;
          });
          ul.appendChild(li);
        });
        // if configured, init MQTT subscription for live updates
        if (cfg.MQTT_WS && cfg.MQTT_SUBSCRIBE_LIVE) {
          initMqttForList(list);
        }
      } catch (e) {
        console.error('loadAndRenderLocations', e);
      }
    }
  
    // Minimal mqtt integration to update list badges
    let mqttClient = null;
    function initMqttForList(list) {
      if (!window.mqtt) {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
        s.onload = () => connectMqtt(list);
        s.onerror = () => console.warn('Failed to load mqtt lib for map live updates');
        document.head.appendChild(s);
      } else {
        connectMqtt(list);
      }
    }
  
    function connectMqtt(list) {
      try {
        mqttClient = window.mqtt.connect(cfg.MQTT_WS, { reconnectPeriod: cfg.MQTT_RECONNECT_MS });
        mqttClient.on('connect', () => {
          console.log('map-locations: mqtt connected');
          // subscribe to each location latest
          list.forEach(loc => {
            const topic = `${cfg.MQTT_TOPIC_BASE}/${loc.locationId}/latest`;
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
              if (err) console.warn('subscribe fail', topic, err);
            });
          });
        });
        mqttClient.on('message', (topic, message) => {
          try {
            const txt = message.toString();
            const payload = JSON.parse(txt);
            // payload expected: { locationId, sheetName, timestamp, rowCount, rows: [...] }
            if (!payload || !payload.locationId) return;
            const locId = payload.locationId;
            const rows = Array.isArray(payload.rows) ? payload.rows : null;
            // pick last row and attempt to extract water/air temp
            const last = rows && rows.length ? rows[rows.length - 1] : null;
            const li = document.querySelector(`[data-location-id="${locId}"]`);
            if (!li) return;
            const tsEl = li.querySelector('.live-ts');
            const sumEl = li.querySelector('.live-summary');
            if (payload.timestamp) tsEl.textContent = new Date(payload.timestamp).toLocaleString();
            if (last) {
              // try find keys loosely
              let water = null, air = null;
              for (const k of Object.keys(last)) {
                const lk = k.toLowerCase();
                const v = last[k];
                if (lk.includes('water') && lk.includes('temp')) { const n = Number(String(v).replace(',', '.')); if (!isNaN(n)) water = n; }
                if (lk.includes('temp') && (lk.includes('udara') || lk.includes('air'))) { const n = Number(String(v).replace(',', '.')); if (!isNaN(n)) air = n; }
                if (!water && (lk === 'Water Temp (C)' || lk.includes('sst'))) { const n = Number(String(last[k]).replace(',', '.')); if (!isNaN(n)) water = n; }
                if (!air && (lk === 'temp udara' || lk === 'temp_udara')) { const n = Number(String(last[k]).replace(',', '.')); if (!isNaN(n)) air = n; }
              }
              let txt = '';
              if (water !== null) txt += `W:${water}°C `;
              if (air !== null) txt += `A:${air}°C`;
              if (!txt) txt = 'data';
              sumEl.textContent = txt;
            } else {
              sumEl.textContent = `rows:${payload.rowCount||'-'}`;
            }
          } catch (e) {
            console.warn('map mqtt message handler error', e);
          }
        });
        mqttClient.on('error', (e) => console.warn('map mqtt error', e));
      } catch (e) {
        console.warn('connectMqtt error', e);
      }
    }
  
    // initial run
    document.addEventListener('DOMContentLoaded', loadAndRenderLocations);
    // expose debug
    window.MAP_LOC = window.MAP_LOC || {};
    window.MAP_LOC.mqttClient = () => mqttClient;
  })();
  