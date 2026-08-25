/**
 * The remote control page, served at `GET /control`.
 *
 * A sibling of the watched-flights page and built the same way -- one
 * self-contained string, no template literals in its own JS, everything escaped
 * before it reaches innerHTML. See src/tracked/page.ts for why.
 *
 * WHAT MAKES THIS PAGE DIFFERENT from the LAN one is that it is never looking at
 * the device. It reads what the wall last REPORTED and queues what the wall will
 * later COLLECT, so everything on it is in the past or the future and nothing is
 * live. Every reading therefore carries its age, and a queued change says it is
 * queued rather than pretending it happened. A control page that shows an
 * intention as though it were a fact is worse than one that shows nothing.
 *
 * There are no WiFi fields, and no control-token field, because neither can be
 * set remotely -- see stripProtected. The page says so rather than omitting them
 * silently, so nobody goes looking for a control that was deliberately removed.
 */
export const controlPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>FlightWall — remote control</title>
<style>
  :root { --bg:#0b0f17; --card:#141a26; --line:#26314a; --fg:#e8edf6; --muted:#8a98b5; --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { position:sticky; top:0; z-index:2; background:rgba(11,15,23,.94); border-bottom:1px solid var(--line); padding:14px 20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.3px; }
  .spacer { flex:1; }
  .wrap { max-width:760px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .card > h2 { font-size:12px; margin:0 0 12px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; font-weight:600; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select, button { font:inherit; }
  input, select { width:100%; padding:9px 10px; background:#0e1420; border:1px solid var(--line); border-radius:8px; color:var(--fg); }
  button { padding:9px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border-color:var(--line); }
  button.warn { background:transparent; color:var(--warn); border-color:var(--warn); }
  button[disabled] { opacity:.45; cursor:not-allowed; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .row > div { flex:1 1 150px; }
  .bar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .pill { display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:.6px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
  .pill.on { color:var(--ok); border-color:var(--ok); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .help { display:block; color:var(--muted); font-size:12px; margin-top:8px; }
  .err { color:var(--warn); font-size:13px; min-height:18px; margin-top:8px; }
  .check { display:block; margin:8px 0; color:var(--fg); font-size:14px; }
  .check input { width:auto; margin-right:8px; }
  .kv { display:flex; justify-content:space-between; gap:12px; border-top:1px solid var(--line); padding:7px 0; font-size:14px; }
  .kv:first-child { border-top:0; }
  .kv span:first-child { color:var(--muted); }
  @media (max-width:560px) { .wrap { padding:14px; } .card { padding:14px; } }
</style>
</head>
<body>

<header>
  <h1>FlightWall · remote control</h1>
  <span class="pill" id="agePill">…</span>
  <span class="spacer"></span>
  <button class="ghost" id="refreshBtn">Refresh</button>
  <button class="ghost" id="forgetBtn" hidden>Forget token</button>
</header>

<div class="wrap">

  <div class="card" id="authCard" hidden>
    <h2>Token</h2>
    <div class="help" style="margin-top:0">This page is gated by the server's <b>CONTROL_TOKEN</b>. It is
      kept in this browser only, and whoever holds it can reconfigure and restart the wall.</div>
    <label for="tok">Control token</label>
    <input id="tok" type="password" autocomplete="off" />
    <div class="bar" style="margin-top:10px"><button id="authBtn">Unlock</button></div>
    <div class="err" id="authErr"></div>
  </div>

  <div id="main" hidden>
    <div class="card">
      <h2>What the wall last reported</h2>
      <div id="status"></div>
      <small class="help" id="staleNote"></small>
    </div>

    <div class="card" id="noSettingsCard" hidden>
      <h2>Controls unavailable</h2>
      <div class="help" style="margin-top:0">The wall has not reported its current settings — it is
        either running firmware from before this feature or has not checked in yet. The controls stay
        hidden rather than appearing empty, because an empty form submits as real values and would
        change settings you never touched.</div>
    </div>

    <div class="card">
      <h2>Brightness</h2>
      <div class="row">
        <div><label for="brightness">Base brightness (0–255)</label><input id="brightness" type="number" min="0" max="255" /></div>
        <div><label for="dayBrightness">Day brightness</label><input id="dayBrightness" type="number" min="0" max="255" /></div>
        <div><label for="nightBrightness">Night brightness</label><input id="nightBrightness" type="number" min="0" max="255" /></div>
      </div>
      <span class="check"><input type="checkbox" id="schedEnabled" /> Day/night schedule enabled</span>
      <small class="help">With the schedule on, the day and night values win over the base brightness —
        so changing the base alone may look like nothing happened.</small>
      <div class="bar" style="margin-top:10px"><button data-send="brightness">Queue brightness</button></div>
    </div>

    <div class="card">
      <h2>Display</h2>
      <div class="row">
        <div><label for="cycleSeconds">Seconds per flight</label><input id="cycleSeconds" type="number" min="1" /></div>
        <div><label for="maxFlights">Max flights</label><input id="maxFlights" type="number" min="1" max="20" /></div>
        <div><label for="fetchIntervalSeconds">Fetch interval (s)</label><input id="fetchIntervalSeconds" type="number" min="5" /></div>
      </div>
      <label for="noFlightsMode">When no flights</label>
      <select id="noFlightsMode">
        <option value="dots">Dots</option>
        <option value="clock">Clock</option>
        <option value="funfact">Fun fact</option>
        <option value="clockfact">Clock + fun fact</option>
      </select>
      <small class="help">The fetch interval is also how long a queued change waits before the wall
        collects it — raising it makes this page slower to take effect.</small>
      <div class="bar" style="margin-top:10px"><button data-send="display">Queue display</button></div>
    </div>

    <div class="card">
      <h2>Filters</h2>
      <div class="row">
        <div><label for="minAltitudeFt">Min altitude (ft)</label><input id="minAltitudeFt" type="number" /></div>
        <div><label for="maxAltitudeFt">Max altitude (ft)</label><input id="maxAltitudeFt" type="number" /></div>
      </div>
      <span class="check"><input type="checkbox" id="excludeOnGround" /> Hide aircraft on the ground</span>
      <span class="check"><input type="checkbox" id="showGeneralAviation" /> Show general aviation / private</span>
      <span class="check"><input type="checkbox" id="hideCargo" /> Hide cargo / freight</span>
      <div class="bar" style="margin-top:10px"><button data-send="filters">Queue filters</button></div>
    </div>

    <div class="card">
      <h2>Actions</h2>
      <div class="bar">
        <button class="ghost" data-action="updateui">Update web UI</button>
        <button class="ghost" data-action="updatefw">Update firmware</button>
        <button class="warn" data-action="restart">Restart the wall</button>
      </div>
      <small class="help">Firmware updates are signature-checked on the device; an image that does not
        verify is refused and the wall keeps running what it has.</small>
    </div>

    <div class="card">
      <h2>Queued, not yet collected</h2>
      <div id="pending"></div>
      <div class="err" id="err"></div>
    </div>

    <small class="help" style="text-align:center">WiFi settings and the control token cannot be changed
      from here, by design — a wrong value in either would put the wall out of reach with no way back
      but a cable.</small>
  </div>

</div>

<script>
var TOKEN_KEY = 'flightwall-control-token';
var token = '';

function $(id){ return document.getElementById(id); }
function esc(s){
  var d = document.createElement('div');
  d.textContent = (s == null ? '' : String(s));
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad2(n){ return (n < 10 ? '0' : '') + n; }

function hm(ms){
  var sec = Math.round(ms / 1000);
  if (sec < 90) return sec + 's';
  var min = Math.round(sec / 60);
  if (min < 90) return min + ' min';
  return Math.floor(min / 60) + ' h ' + pad2(min % 60) + ' min';
}

function authHeaders(extra){
  var h = { 'Authorization': 'Bearer ' + token };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// Every request goes through here so a 401 has exactly ONE handler. A stale or
// mistyped token must drop straight back to the unlock card rather than leaving
// a page that looks live and silently answers nothing.
async function api(path, opts){
  var res = await fetch(path, opts || {});
  if (res.status === 401) { lock('That token was not accepted.'); throw new Error('unauthorised'); }
  return res;
}

function lock(message){
  token = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  $('authCard').hidden = false;
  $('main').hidden = true;
  $('forgetBtn').hidden = true;
  $('authErr').textContent = message || '';
  $('agePill').textContent = 'locked';
  $('agePill').className = 'pill';
}

function unlock(){
  $('authCard').hidden = true;
  $('main').hidden = false;
  $('forgetBtn').hidden = false;
}

var FIELDS = {
  brightness: [['display', 'brightness', 'int'], ['schedule', 'dayBrightness', 'int'],
               ['schedule', 'nightBrightness', 'int'], ['schedule', 'schedEnabled', 'bool']],
  display: [['display', 'cycleSeconds', 'int'], ['display', 'maxFlights', 'int'],
            ['display', 'fetchIntervalSeconds', 'int'], ['layout', 'noFlightsMode', 'str']],
  filters: [['filters', 'minAltitudeFt', 'num'], ['filters', 'maxAltitudeFt', 'num'],
            ['filters', 'excludeOnGround', 'bool'], ['filters', 'showGeneralAviation', 'bool'],
            ['filters', 'hideCargo', 'bool']]
};

// The DOM id and the settings key differ for exactly one field; keeping the map
// explicit beats a naming convention nobody can see from the markup.
var KEY_FOR_ID = { schedEnabled: 'enabled' };

function collect(group){
  var out = {};
  var defs = FIELDS[group];
  for (var i = 0; i < defs.length; i++) {
    var section = defs[i][0], id = defs[i][1], kind = defs[i][2];
    var el = $(id);
    if (!el) continue;
    var key = KEY_FOR_ID[id] || id;
    if (!out[section]) out[section] = {};
    if (kind === 'bool') out[section][key] = el.checked;
    else if (kind === 'int') out[section][key] = parseInt(el.value, 10);
    else if (kind === 'num') out[section][key] = parseFloat(el.value);
    else out[section][key] = el.value;
  }
  // Drop anything that did not parse. Sending NaN would be applied by the
  // device as a zero, which is a silent, wrong change rather than a refusal.
  for (var s in out) {
    for (var k in out[s]) {
      if (typeof out[s][k] === 'number' && !isFinite(out[s][k])) delete out[s][k];
    }
    if (Object.keys(out[s]).length === 0) delete out[s];
  }
  return out;
}

async function queue(body, describe){
  $('err').textContent = '';
  try {
    var res = await api('/v1/control/command', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    var j = await res.json();
    if (!j.ok) { $('err').textContent = j.error || 'Could not queue that.'; return; }
    $('err').textContent = '';
    note(describe + ' queued — the wall applies it on its next check-in.');
    touched = false; // let the next poll show what the wall actually adopted
    load();
  } catch (e) {
    if (e.message !== 'unauthorised') $('err').textContent = 'Could not reach the server.';
  }
}

function note(text){
  var el = $('staleNote');
  el.textContent = text;
}

function renderStatus(s, ageMs){
  var el = $('status');
  if (!s) {
    el.innerHTML = '<div class="kv"><span>Never checked in</span><span>—</span></div>';
    $('agePill').textContent = 'no contact';
    $('agePill').className = 'pill warn';
    return;
  }
  var rows = [
    ['Firmware', s.fwVersion],
    ['Flights on the wall', s.flightCount],
    ['Last fetch', s.note],
    ['Panel brightness', s.panelOff ? '0 (switched off by the button)' : s.brightness],
    ['Mode', s.mode],
    ['Signal', s.rssi != null ? s.rssi + ' dBm' : null],
    ['LAN address', s.ip],
    ['Uptime', s.uptimeS != null ? hm(s.uptimeS * 1000) : null]
  ];
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][1] === null || rows[i][1] === undefined) continue;
    html += '<div class="kv"><span>' + esc(rows[i][0]) + '</span><span>' + esc(rows[i][1]) + '</span></div>';
  }
  el.innerHTML = html;

  // The age is the most important thing on the page. Everything else here is a
  // report from the past, and how far past decides whether it means anything.
  var pill = $('agePill');
  pill.textContent = hm(ageMs) + ' ago';
  // Three minutes is comfortably more than a 60s cycle plus a slow fetch, so
  // crossing it means the wall has genuinely missed check-ins rather than
  // merely being between them.
  pill.className = ageMs > 180000 ? 'pill warn' : 'pill on';
}

function renderPending(list){
  var el = $('pending');
  if (!list || !list.length) {
    el.innerHTML = '<small class="help" style="margin:0">Nothing waiting. The wall has collected everything queued.</small>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var what = c.action ? ('action: ' + c.action) : JSON.stringify(c.set);
    html += '<div class="kv"><span>' + esc(what) + '</span><span>queued</span></div>';
  }
  el.innerHTML = html;
}

// Fill the form from what the wall reported.
//
// Load-bearing rather than convenient. Without it every field starts empty and
// a submit sends that emptiness: an untouched checkbox reads as "set this to
// false", and queueing one filter change would silently clear two others. The
// form has to mirror the device before it can safely offer to change it.
//
// Frozen once the user starts editing, so a poll landing mid-edit cannot snatch
// a half-typed value back to what the wall last said.
var touched = false;
function populate(st){
  if (!st || touched) return;
  var d = st.display || {}, sc = st.schedule || {}, f = st.filters || {}, l = st.layout || {};
  var pairs = [
    ['brightness', d.brightness], ['cycleSeconds', d.cycleSeconds],
    ['maxFlights', d.maxFlights], ['fetchIntervalSeconds', d.fetchIntervalSeconds],
    ['dayBrightness', sc.dayBrightness], ['nightBrightness', sc.nightBrightness],
    ['minAltitudeFt', f.minAltitudeFt], ['maxAltitudeFt', f.maxAltitudeFt],
    ['noFlightsMode', l.noFlightsMode]
  ];
  for (var i = 0; i < pairs.length; i++) {
    var el = $(pairs[i][0]);
    if (el && pairs[i][1] !== undefined && pairs[i][1] !== null) el.value = pairs[i][1];
  }
  var checks = [
    ['schedEnabled', sc.enabled], ['excludeOnGround', f.excludeOnGround],
    ['showGeneralAviation', f.showGeneralAviation], ['hideCargo', f.hideCargo]
  ];
  for (var j2 = 0; j2 < checks.length; j2++) {
    var c = $(checks[j2][0]);
    if (c && checks[j2][1] !== undefined && checks[j2][1] !== null) c.checked = !!checks[j2][1];
  }
}

document.addEventListener('input', function(){ touched = true; });
document.addEventListener('change', function(){ touched = true; });

var timer = null, busy = false;

async function load(){
  if (!token) return;
  try {
    var res = await api('/v1/control', { headers: authHeaders() });
    var j = await res.json();
    if (!j.ok) return;
    unlock();

    // No settings reported -> hide the controls rather than showing them empty.
    // An empty form submits as a set of REAL values: an untouched checkbox
    // reads as "set this to false", so offering one would change settings
    // nobody touched.
    var haveSettings = !!(j.status && j.status.settings);
    $('noSettingsCard').hidden = haveSettings;
    var sendables = document.querySelectorAll('[data-send]');
    for (var ci = 0; ci < sendables.length; ci++) {
      var card = sendables[ci].closest('.card');
      if (card) card.hidden = !haveSettings;
    }

    renderStatus(j.status, j.statusAgeMs == null ? 0 : j.statusAgeMs);
    populate(j.status && j.status.settings);
    if (j.status === null) { $('agePill').textContent = 'no contact'; $('agePill').className = 'pill warn'; }
    renderPending(j.pending);
  } catch (e) {
    if (e.message !== 'unauthorised') {
      $('agePill').textContent = 'unreachable';
      $('agePill').className = 'pill warn';
    }
  }
}

// Reschedules after the response rather than on a fixed interval, so a slow
// server cannot stack polls -- same reasoning as the watched-flights page.
async function poll(){
  clearTimeout(timer);
  if (busy || !token) return;
  busy = true;
  try { await load(); }
  finally { busy = false; if (token) timer = setTimeout(poll, 15000); }
}

$('authBtn').onclick = function(){
  token = $('tok').value.trim();
  if (!token) { $('authErr').textContent = 'Enter the token.'; return; }
  try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  $('tok').value = '';
  $('authErr').textContent = '';
  poll();
};
$('tok').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') $('authBtn').onclick(); });
$('refreshBtn').onclick = poll;
$('forgetBtn').onclick = function(){ lock('Token forgotten on this device.'); };

var sendButtons = document.querySelectorAll('[data-send]');
for (var i = 0; i < sendButtons.length; i++) {
  (function(b){
    b.onclick = function(){
      var group = b.getAttribute('data-send');
      var set = collect(group);
      if (Object.keys(set).length === 0) { $('err').textContent = 'Nothing to send — fill something in first.'; return; }
      queue({ set: set }, group.charAt(0).toUpperCase() + group.slice(1));
    };
  })(sendButtons[i]);
}

var actionButtons = document.querySelectorAll('[data-action]');
for (var i = 0; i < actionButtons.length; i++) {
  (function(b){
    b.onclick = function(){
      var a = b.getAttribute('data-action');
      var warn = a === 'restart'
        ? 'Restart the wall? It goes dark for about a minute.'
        : 'Queue "' + a + '"? The wall performs it on its next check-in.';
      if (!confirm(warn)) return;
      queue({ action: a }, a);
    };
  })(actionButtons[i]);
}

try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
if (token) poll(); else lock('');
</script>
</body>
</html>
`;
