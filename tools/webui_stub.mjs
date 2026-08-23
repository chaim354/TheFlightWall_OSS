#!/usr/bin/env node
//
// Stub of the device's HTTP API, so firmware/data/index.html can be driven in a
// real browser with no board attached.
//
//     node tools/webui_stub.mjs            # http://localhost:8099
//     node tools/webui_stub.mjs 9000       # another port
//
// The page is read from disk per request, so edits show up on reload. Node
// built-ins only -- no install step.
//
// WHY THIS EXISTS. index.html has no other test surface: it is served from
// LittleFS by a board on a wall, and the only way to exercise it used to be
// `pio run -t uploadfs`, which erases /settings.json. So its behaviour went
// unverified, and four defects accumulated there (F-FW05-A/B/C and F-X05-A in
// the 2026-08-23 audit) -- including a Save button that would persist a blank
// form over live config, and an SSID interpolated unescaped into innerHTML.
// Each was reproduced here first, then fixed, then re-verified. Two of them
// were only fully understood because this harness disagreed with the reading:
// see the "Refresh" note under F-FW05-B below.
//
// ---------------------------------------------------------------------------
// KNOBS. Set as query params on the page URL; they stick until changed.
//
//   ?settingsDelay=N   ms before GET /api/settings answers
//   ?settingsFail=1    GET /api/settings answers 500
//   ?statusDelay=N     ms before GET /api/status answers
//   ?statusFail=1      GET /api/status answers 500
//   ?ssid=...          SSID reported by /api/status
//   ?heap=0            omit largestInternal/largestDma/freeInternal/freePsram,
//                      as firmware from before those were added would
//
// GET /__probe   what the harness saw: POST bodies, request counts, and the
//                peak number of concurrent /api/status requests
// GET /__reset   clear counters (deliberately NOT the in-flight gauge)
//
// ---------------------------------------------------------------------------
// REPRODUCING THE FOUR FINDINGS. Run these in the browser console against the
// page. Each is written as the assertion that FAILS on unfixed code.
//
//   F-FW05-C  security: SSID is attacker-controlled from the RF environment
//     open  /?ssid=%3Cimg%20src%3Dx%20onerror%3D%22window.__XSS%3D1%22%3E
//     then  window.__XSS === 1        // true = the payload executed
//
//   F-FW05-A  Save can persist a blank form over live config
//     open  /?settingsDelay=30000     // long, or tool latency outruns it
//     then  document.getElementById('saveBtn').disabled     // must be true
//           await save(); (await (await fetch('/__probe')).json()).posts
//                                                          // must be []
//     A POST here carries a COMPLETE document of HTML defaults -- blank
//     credentials, panelRes 0x0, brightness 0 -- not a partial one.
//
//   F-X05-A  the page showed only the heap number known to mislead
//     open  /?heap=1   -> expect pills for largest / dma / int / psram
//     open  /?heap=0   -> expect those pills absent, and NOT "undefinedk"
//
//   F-FW05-B  overlapping polls
//     open  /?statusDelay=7000, wait ~25s, read /__probe statusPeak (want 1)
//     then  for (let i=0;i<5;i++) { loadAll(); await new Promise(r=>setTimeout(r,150)); }
//           wait ~22s, read statusPeak again (want 1)
//     The second half is the one that matters: Refresh calls loadStatus
//     directly on top of the timer, so bounding the timer alone still let
//     rapid clicks stack. That only showed up by measuring.
//
// NOTE ON TIMING. Driving this from an agent tool, a round trip can take
// several seconds. Any delay you want to observe must be comfortably longer
// than that, or you will measure the post-load state and conclude the guard is
// missing. Record performance.now() alongside the assertion.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.WEBUI_PAGE ?? path.join(HERE, '..', 'firmware', 'data', 'index.html');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8099);

const knobs = { settingsDelay: 0, settingsFail: 0, statusDelay: 0, statusFail: 0, ssid: 'HomeWiFi', heap: 1 };
const probe = { posts: [], settingsGets: 0, statusGets: 0, flightGets: 0, statusInFlight: 0, statusPeak: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What GET /api/settings answers. Must stay a superset of every field
 * loadSettings() reads -- see the self-check below, which is not optional
 * decoration: this stub silently drifted from the page twice while the audit
 * fixes were being written, and both times the symptom was loadSettings
 * throwing midway and Save simply never arming. A missing field here looks
 * exactly like the bug under test.
 */
const SETTINGS = {
  network: { wifiSsid: 'HomeWiFi', wifiPassword: 'hunter2' },
  api: {
    openSkyClientId: 'osky-id', openSkyClientSecret: 'osky-secret', aeroApiKey: 'aero-key',
    positionSource: 'server', serverUrl: 'https://flightwall.example',
    enrichmentSource: 'adsbdb', enrichmentFallbackToAeroApi: false,
  },
  tracking: {
    centerLat: 40.6413, centerLon: -73.7781, radiusKm: 10, mode: 'flights',
    autoLocateOnBoot: false, trackedFlights: [],
  },
  filters: {
    airlineAllowList: [], excludeOnGround: true, hideCargo: false,
    showGeneralAviation: false, minAltitudeFt: 0, maxAltitudeFt: 60000,
  },
  display: {
    brightness: 20, maxFlights: 12, cycleSeconds: 3, fetchIntervalSeconds: 30,
    textColorR: 255, textColorG: 255, textColorB: 255,
  },
  layout: { noFlightsMode: 'clockfact' },
  schedule: {
    enabled: true, timezone: 'EST5EDT,M3.2.0,M11.1.0', dayBrightness: 20,
    nightBrightness: 5, nightStartHour: 23, nightEndHour: 7,
  },
  light: { enabled: true, type: 'tcs3472', pin: 1, darkThreshold: 500, dimBrightness: 5, dimInstead: true, hysteresis: 30 },
  buttons: { enabled: true },
  hardware: {
    panelResX: 64, panelResY: 64, panelChain: 2, panelClkPhase: true,
    panelDriverChip: 'shift', panelI2sSpeedMhz: 8, panelLatchBlanking: 1,
  },
};

/** Every `s.<section>.<field>` the page reads must exist above. */
function checkSettingsCoverage() {
  let page;
  try {
    page = readFileSync(PAGE, 'utf8');
  } catch {
    console.error(`cannot read ${PAGE}`);
    process.exit(1);
  }
  // Scan ONLY loadSettings()'s body. Elsewhere in the page `s` is the
  // /api/status object, so a whole-file scan would have to skip unknown
  // sections -- and skipping them means a section deleted from SETTINGS goes
  // unnoticed, which is the drift that actually happened.
  const body = page.match(/async function loadSettings\(\)\s*\{([\s\S]*?)\n\}/);
  if (!body) {
    console.error('cannot find loadSettings() in the page; this check needs updating');
    process.exit(1);
  }
  const missing = new Set();
  for (const m of body[1].matchAll(/\bs\.([a-zA-Z]+)\.([a-zA-Z0-9]+)/g)) {
    const [, section, field] = m;
    const sec = SETTINGS[section];
    if (sec === undefined) missing.add(`${section}  (whole section)`);
    else if (!(field in sec)) missing.add(`${section}.${field}`);
  }
  if (missing.size) {
    console.error(
      `\nThis stub is missing ${missing.size} field(s) index.html reads:\n  ` +
        [...missing].sort().join('\n  ') +
        `\n\nAdd them to SETTINGS. Without them loadSettings() throws partway and\n` +
        `Save never arms -- which is indistinguishable from the bug under test.\n`,
    );
    process.exit(1);
  }
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

checkSettingsCoverage();

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  for (const k of Object.keys(knobs)) {
    if (url.searchParams.has(k)) {
      const v = url.searchParams.get(k);
      knobs[k] = k === 'ssid' ? v : Number(v);
    }
  }

  if (url.pathname === '/__probe') return json(res, { ...probe, knobs });
  if (url.pathname === '/__reset') {
    // Deliberately does NOT clear statusInFlight: zeroing it while a request is
    // still in flight makes the later decrement go negative and statusPeak read
    // 0, which reads as "the fix works" when nothing was measured at all.
    Object.assign(probe, { posts: [], settingsGets: 0, statusGets: 0, flightGets: 0 });
    probe.statusPeak = probe.statusInFlight;
    return json(res, { ok: true });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(PAGE, 'utf8'));
  }

  if (url.pathname === '/api/settings') {
    if (req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      probe.posts.push(body);
      return json(res, { ok: true });
    }
    probe.settingsGets++;
    if (knobs.settingsDelay) await sleep(knobs.settingsDelay);
    if (knobs.settingsFail) return json(res, { error: 'stubbed failure' }, 500);
    return json(res, SETTINGS);
  }

  if (url.pathname === '/api/status') {
    probe.statusGets++;
    probe.statusInFlight++;
    probe.statusPeak = Math.max(probe.statusPeak, probe.statusInFlight);
    if (knobs.statusDelay) await sleep(knobs.statusDelay);
    probe.statusInFlight--;
    if (knobs.statusFail) return json(res, { error: 'stubbed failure' }, 500);
    const base = {
      apMode: false, wifiConnected: true, ssid: knobs.ssid, ip: '192.168.1.42',
      mode: 'flights', flightCount: 7, rssi: -58, serverStale: false, freeHeap: 178000,
      i2cSda: 41, i2cScl: 42, adc1Min: 1, adc1Max: 10,
      buttonAPin: 18, buttonBPin: 21, lightLevel: 240, lightDark: false,
    };
    // The four WebConfigServer.cpp added because freeHeap alone misled a live
    // diagnosis. ?heap=0 omits them, standing in for older firmware.
    const heap = { largestInternal: 151540, largestDma: 98304, freeInternal: 174000, freePsram: 8350000 };
    return json(res, knobs.heap ? { ...base, ...heap } : base);
  }

  if (url.pathname === '/api/flights') {
    probe.flightGets++;
    return json(res, [
      {
        ident: 'DAL1234', airline: 'Delta', origin: 'JFK', destination: 'LAX',
        aircraft: 'B738', distanceKm: 4.2, altitudeFt: 18000, speedKt: 400,
        headingDeg: 263, verticalRateFpm: -640,
      },
      // Exercises the escaping on the flight list too -- these fields come off
      // the wire from a server the user configures.
      { ident: '<b>XSS</b>', airline: '<i>hax</i>', origin: 'EWR', destination: 'BOS', aircraft: 'E75L', distanceKm: 9.9 },
    ]);
  }

  if (url.pathname === '/api/restart') return json(res, { ok: true });
  if (url.pathname === '/api/wifiscan') return json(res, [{ ssid: 'HomeWiFi', rssi: -58 }]);
  if (url.pathname === '/api/geolocate') return json(res, { ok: false });

  res.writeHead(404);
  res.end('not stubbed');
}).listen(PORT, () => {
  console.log(`web UI stub: http://localhost:${PORT}`);
  console.log(`serving ${path.relative(process.cwd(), PAGE)}`);
});
