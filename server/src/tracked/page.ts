import { MAX_ENTRIES, WINDOW_FUTURE_DAYS, WINDOW_PAST_DAYS } from './routes';
import { EXPIRE_AFTER_LANDED_MS, EXPIRE_AFTER_UNRESOLVED_MS, MAX_TZ_LEAD_MS } from './lifecycle';
import { FIX_FRESH_MS } from './serve';

/**
 * The watched-flights page, served at `GET /` by server.ts.
 *
 * ONE SELF-CONTAINED STRING, deliberately. The runtime image ships nothing but
 * `dist/server.js` (see Dockerfile: the final stage copies only that, and the
 * package has no runtime dependencies), so a page read from disk at request
 * time would 404 in production while working perfectly in `npm run dev`.
 * Embedding it means esbuild bundles the page into the same file as the code
 * that serves it, and there is no second artifact to forget to ship.
 *
 * It is the FIRST user interface this endpoint has had. Until now the only way
 * to watch a flight was to hand-write a curl POST, which is why routes.ts
 * bothers to return a human-readable `error` string on every rejection -- that
 * comment says "this endpoint IS the user interface". It no longer is, so those
 * strings are rendered verbatim under the form rather than being invented again
 * here in different words.
 *
 * UNAUTHENTICATED, exactly like the API it drives. Anyone who can reach the
 * page could already POST to /v1/tracked; serving it adds discoverability, not
 * capability. The four guards that bound the open endpoint (entry cap, date
 * window, daily resolution ceiling, auto-expiry) are unchanged and are what the
 * exposure rests on -- see server/README.md.
 *
 * The page's own JS deliberately uses no template literals: it lives inside one
 * here, and `${` would have to be escaped at every use, which is the kind of
 * detail that survives review by looking fine and then breaks at runtime.
 * String concatenation reads worse and cannot fail that way.
 */
export const trackedPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>FlightWall — watched flights</title>
<style>
  :root { --bg:#0b0f17; --card:#141a26; --line:#26314a; --fg:#e8edf6; --muted:#8a98b5; --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; }
  * { box-sizing:border-box; }
  /* !important because .pill sets display:inline-block, and a class selector
     outranks the UA stylesheet's [hidden] rule -- so the count pill went on
     showing "…" next to the title on a server with the feature switched off. */
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { position:sticky; top:0; z-index:2; background:rgba(11,15,23,.94); border-bottom:1px solid var(--line); padding:14px 20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.3px; }
  .spacer { flex:1; }
  .wrap { max-width:760px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .card > h2 { font-size:12px; margin:0 0 12px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; font-weight:600; }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 4px; }
  input, button { font:inherit; }
  input { width:100%; padding:9px 10px; background:#0e1420; border:1px solid var(--line); border-radius:8px; color:var(--fg); }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { padding:9px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border-color:var(--line); }
  button.danger { background:transparent; color:var(--warn); border-color:var(--line); padding:5px 10px; font-size:13px; }
  button[disabled] { opacity:.45; cursor:not-allowed; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .row > div { flex:1 1 150px; }
  .pill { display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:.6px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
  .pill.on { color:var(--ok); border-color:var(--ok); }
  .pill.go { color:var(--accent); border-color:var(--accent); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .help { display:block; color:var(--muted); font-size:12px; margin-top:10px; }
  .err { color:var(--warn); font-size:13px; margin-top:10px; min-height:19px; }
  .entry { border-top:1px solid var(--line); padding:14px 0 4px; }
  .entry:first-child { border-top:0; padding-top:0; }
  /* Two columns, not one wrapping row: the identity block wraps within itself
     while Remove stays pinned top-right at every width. Wrapping the button
     along with the pills dropped it onto its own line on a phone, directly
     under the flight number, where it read as part of the next field. */
  .top { display:flex; align-items:flex-start; gap:10px; justify-content:space-between; }
  .ids { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .num { font-size:18px; font-weight:600; letter-spacing:.5px; }
  .line { color:var(--muted); font-size:13px; margin-top:5px; }
  .line b { color:var(--fg); font-weight:500; }
  .line.warn b, .line.warn { color:var(--warn); }
  @media (max-width:560px) { .wrap { padding:14px; } .card { padding:14px; } }
</style>
</head>
<body>

<header>
  <h1>FlightWall · watched flights</h1>
  <span class="pill" id="countPill">…</span>
  <span class="spacer"></span>
  <span class="pill" id="freshPill">loading…</span>
  <button class="ghost" id="refreshBtn">Refresh</button>
</header>

<div class="wrap">

  <div class="card" id="offCard" hidden>
    <h2>Watched flights are switched off</h2>
    <div class="line"><b>This server has no OpenSky credentials.</b> Without them nothing can follow an
      aircraft once it is airborne, so the feature stays inert rather than accepting flights it could
      never track: <code>/v1/tracked</code> answers 404 and the tick never starts.</div>
    <div class="line">Set <b>OPENSKY_CLIENT_ID</b> and <b>OPENSKY_CLIENT_SECRET</b> in the server's
      environment and redeploy.</div>
  </div>

  <div class="card" id="addCard">
    <h2>Watch a flight</h2>
    <div class="row">
      <div>
        <label for="num">Flight number</label>
        <input id="num" placeholder="BA181" autocomplete="off" spellcheck="false" autocapitalize="characters" />
      </div>
      <div>
        <label for="date">Departure date</label>
        <input id="date" type="date" />
      </div>
      <div style="flex:0 0 auto">
        <button id="addBtn">Watch</button>
      </div>
    </div>
    <div class="err" id="addErr"></div>
    <small class="help">One journey, not a subscription: a flight number plus the single date it departs.
      The date is the one <b>on the boarding pass</b> — local to the departure airport, so a 20:55
      departure from JFK is the 24th even though it is already the 25th in UTC. Watching costs nothing
      until that date begins; the flight is looked up then, and followed live once it is in the air.
      Entries remove themselves a couple of hours after landing.</small>
  </div>

  <div class="card">
    <h2>Watching</h2>
    <div id="list"><small class="help">loading…</small></div>
  </div>

  <small class="help" style="text-align:center">This page is unauthenticated, exactly like the API it
    drives — anyone who can reach it can add and remove flights.</small>

</div>

<script>
var MAX = ${MAX_ENTRIES};
var FRESH_MS = ${FIX_FRESH_MS};
var DAY_MS = 86400000;
var WINDOW_PAST_DAYS = ${WINDOW_PAST_DAYS};
var WINDOW_FUTURE_DAYS = ${WINDOW_FUTURE_DAYS};
var EXPIRE_LANDED_MS = ${EXPIRE_AFTER_LANDED_MS};
var EXPIRE_UNRESOLVED_MS = ${EXPIRE_AFTER_UNRESOLVED_MS};
var TZ_LEAD_MS = ${MAX_TZ_LEAD_MS};

function $(id){ return document.getElementById(id); }

// HTML-escape before interpolating into innerHTML. Everything an entry carries
// beyond its own id is upstream text -- AeroDataBox's aircraft model and
// airport codes, a failure reason built from an upstream message -- and the
// flight number is whatever a stranger typed into the form on this open page.
//
// The quote pass is not decoration. textContent -> innerHTML escapes & < >
// but leaves both quote characters alone, and some of these values land in
// ATTRIBUTES (data-del, data-num, title), where a bare quote closes the
// attribute early and everything after it is parsed as markup. Nothing that
// reaches here today can contain one -- ids are UUIDs, numbers are normalised
// to /^[A-Z0-9]{2,3}\d{1,4}$/ server-side -- which is precisely why the gap
// would sit unnoticed until some field that can gets rendered the same way.
function esc(s){
  var d = document.createElement('div');
  d.textContent = (s == null ? '' : String(s));
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad2(n){ return (n < 10 ? '0' : '') + n; }

// The browser's own calendar date, offset by whole days. Local, not UTC: the
// date field means the date at the DEPARTURE airport, and this page's reader is
// far more often in that airport's timezone than in UTC. It cannot be exact for
// a flight leaving the other side of the world -- nothing here knows which
// airport that is until the flight resolves -- so it is a sensible default and
// a generous bound, not a claim.
function localDay(offsetDays){
  var d = new Date(Date.now() + offsetDays * DAY_MS);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// The UTC calendar date, offset by whole days -- what the server's own window
// check is measured against (routes.ts compares startOfUtcDay to UTC today).
// The BOUNDS use this and the DEFAULT uses localDay above, deliberately: the
// default should be the date the reader is living in, but a bound that does not
// match the validator is worse than no bound, because it offers a date the POST
// then refuses. Late evening in New York is exactly when they disagree -- local
// 24th, UTC already the 25th -- and a local-dated min would have offered the
// 23rd, which the server rejects as in the past.
function utcDay(offsetDays){ return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10); }

// Local wall-clock time, with the UTC instant on the title attribute. Neither
// is the flight's own local time and this does not pretend otherwise: it labels
// what it shows and puts the unambiguous value one hover away.
function hhmm(epochSec){
  var d = new Date(epochSec * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function utcStamp(epochSec){
  var s = new Date(epochSec * 1000).toISOString();
  return s.slice(0, 10) + ' ' + s.slice(11, 16) + 'Z';
}

// "42 min" / "20 h 58 min". The minutes keep their unit at both lengths: "20 h
// 58" reads as a time of day at a glance, which is the one thing this is not.
function hm(ms){
  var min = Math.round(ms / 60000);
  if (min < 90) return min + ' min';
  return Math.floor(min / 60) + ' h ' + pad2(min % 60) + ' min';
}

// What lifecycle.ts's terminal timers have left to run, measured from the
// entry's own stateAtMs. A flat "about two hours from now" was wrong for every
// entry except one landing this instant, which is exactly the plausible-looking
// wrong value this codebase keeps having to stamp out; when stateAtMs is
// missing (an entry written before it existed) it states the RULE instead of
// inventing a deadline.
function expiresIn(e, now, windowMs){
  if (typeof e.stateAtMs !== 'number') return 'after ' + hm(windowMs);
  var left = windowMs - (now - e.stateAtMs);
  return left <= 0 ? 'on the next tick' : 'in about ' + hm(left);
}

function ago(ms){ return ms < 45000 ? 'just now' : hm(ms) + ' ago'; }

var STATE_PILL = {
  airborne:   { cls: 'pill on',   text: 'airborne' },
  resolved:   { cls: 'pill go',   text: 'resolved' },
  pending:    { cls: 'pill',      text: 'waiting' },
  landed:     { cls: 'pill',      text: 'landed' },
  unresolved: { cls: 'pill warn', text: 'not found' },
  expired:    { cls: 'pill',      text: 'expiring' }
};
var STATE_ORDER = { airborne: 0, resolved: 1, pending: 2, landed: 3, unresolved: 4, expired: 5 };

function line(html, warn){ return '<div class="line' + (warn ? ' warn' : '') + '">' + html + '</div>'; }

function routeLine(e){
  var bits = [];
  if (e.origIata || e.destIata) bits.push('<b>' + esc(e.origIata || '???') + ' → ' + esc(e.destIata || '???') + '</b>');
  if (e.schedDepEpoch !== null && e.schedDepEpoch !== undefined)
    bits.push('dep <span title="' + esc(utcStamp(e.schedDepEpoch)) + '">' + hhmm(e.schedDepEpoch) + '</span>');
  if (e.schedArrEpoch !== null && e.schedArrEpoch !== undefined)
    bits.push('arr <span title="' + esc(utcStamp(e.schedArrEpoch)) + '">' + hhmm(e.schedArrEpoch) + '</span>');
  if (!bits.length) return '';
  return line(bits.join(' · ') + ' <span style="opacity:.7">· times local</span>');
}

function aircraftLine(e){
  var bits = [];
  if (e.reg) bits.push('<b>' + esc(e.reg) + '</b>');
  if (e.aircraftModel) bits.push(esc(e.aircraftModel));
  if (e.icao24) bits.push('hex ' + esc(e.icao24));
  return bits.length ? line(bits.join(' · ')) : '';
}

// Whether the wall is drawing a card for this entry right now, by the SAME rule
// src/tracked/serve.ts applies when it builds one: a fix newer than FIX_FRESH_MS,
// or failing that a route complete enough to dead-reckon along (deadReckon.ts
// returns null on partial input, so a half-known route yields no card at all).
// Kept in step with those two files through the constants interpolated above --
// if the freshness window moves, this moves with it.
function panelLine(e, now){
  if (e.state !== 'airborne') return '';
  var fixAge = (e.lastPosAtMs === null || e.lastPosAtMs === undefined) ? null : now - e.lastPosAtMs;
  var fresh = e.lastLat !== null && e.lastLat !== undefined && e.lastLon !== null && fixAge !== null && fixAge <= FRESH_MS;

  if (fresh) {
    var m = [];
    if (e.lastAltFt !== null && e.lastAltFt !== undefined) m.push(Math.round(e.lastAltFt) + ' ft');
    if (e.lastGroundspeedKt !== null && e.lastGroundspeedKt !== undefined) m.push(Math.round(e.lastGroundspeedKt) + ' kt');
    if (e.lastHeadingDeg !== null && e.lastHeadingDeg !== undefined) m.push('HDG ' + pad2(Math.round(e.lastHeadingDeg)));
    if (e.lastVerticalRateFpm !== null && e.lastVerticalRateFpm !== undefined)
      m.push((e.lastVerticalRateFpm > 0 ? '+' : '') + Math.round(e.lastVerticalRateFpm) + ' fpm');
    return line('<b>On the wall</b> · live fix ' + ago(fixAge) + (m.length ? ' · ' + m.join(' · ') : ''));
  }

  var canEstimate = !!e.orig && !!e.dest &&
    e.schedDepEpoch !== null && e.schedDepEpoch !== undefined &&
    e.schedArrEpoch !== null && e.schedArrEpoch !== undefined &&
    e.schedArrEpoch > e.schedDepEpoch;
  if (canEstimate) {
    return line('<b>On the wall</b> · estimated position, ' +
      (fixAge === null ? 'no ADS-B fix yet' : 'last fix ' + ago(fixAge)) +
      ' — the marker is drawn hollow');
  }
  return line('<b>Not on the wall</b> · ' +
    (fixAge === null ? 'no ADS-B fix yet' : 'last fix ' + ago(fixAge)) +
    ', and the route is not complete enough to estimate from', true);
}

function statusLine(e, now){
  if (e.state === 'pending') {
    // The lifecycle starts resolving TZ_LEAD_MS before 00:00 UTC on the date,
    // because the date is local to the departure airport and that airport may
    // be as far ahead as UTC+14. Saying "nothing spent yet" past that point
    // would be describing a lookup that has already been paid for.
    var startsMs = Date.parse(e.date + 'T00:00:00Z') - TZ_LEAD_MS;
    var waiting = isFinite(startsMs) && now < startsMs;
    return line(waiting
      ? 'Nothing spent yet — the aircraft is looked up when ' + esc(e.date) + ' begins.'
      : 'Looking up the aircraft — this happens on the next tick, within about five minutes.');
  }
  if (e.state === 'resolved') return line('Aircraft known. Polling starts at the scheduled departure.');
  if (e.state === 'landed') return line('Landed. This entry removes itself ' + expiresIn(e, now, EXPIRE_LANDED_MS) + '.');
  if (e.state === 'unresolved')
    return line('<b>Could not be identified:</b> ' + esc(e.reason || 'no reason recorded') +
      '. Not retried; removed ' + expiresIn(e, now, EXPIRE_UNRESOLVED_MS) + '.', true);
  if (e.state === 'expired') return line('Expired — it will be dropped on the next tick.');
  return '';
}

function entryHtml(e, now){
  var p = STATE_PILL[e.state] || { cls: 'pill', text: String(e.state || '?') };
  var h = '<div class="entry">';
  h += '<div class="top"><div class="ids"><span class="num">' + esc(e.number) + '</span>' +
       '<span class="' + p.cls + '">' + esc(p.text) + '</span>' +
       '<span class="pill">' + esc(e.date) + '</span></div>' +
       '<button class="danger" data-del="' + esc(e.id) + '" data-num="' + esc(e.number) + '">Remove</button></div>';
  h += routeLine(e);
  h += aircraftLine(e);
  h += panelLine(e, now);
  h += statusLine(e, now);
  return h + '</div>';
}

function render(entries){
  var now = Date.now();
  var sorted = entries.slice().sort(function(a, b){
    var ra = STATE_ORDER[a.state] === undefined ? 9 : STATE_ORDER[a.state];
    var rb = STATE_ORDER[b.state] === undefined ? 9 : STATE_ORDER[b.state];
    if (ra !== rb) return ra - rb;
    var ka = a.schedDepEpoch ? a.schedDepEpoch * 1000 : Date.parse(a.date + 'T00:00:00Z');
    var kb = b.schedDepEpoch ? b.schedDepEpoch * 1000 : Date.parse(b.date + 'T00:00:00Z');
    return (ka || 0) - (kb || 0);
  });

  $('list').innerHTML = sorted.length
    ? sorted.map(function(e){ return entryHtml(e, now); }).join('')
    : '<small class="help">Nothing is being watched. Add a flight above and it will be pinned to the top of the wall while it is in the air.</small>';

  var buttons = document.querySelectorAll('[data-del]');
  for (var i = 0; i < buttons.length; i++) {
    (function(b){
      b.onclick = function(){ del(b.getAttribute('data-del'), b.getAttribute('data-num')); };
    })(buttons[i]);
  }

  $('countPill').textContent = entries.length + ' / ' + MAX;
  atCap = entries.length >= MAX;
  $('addBtn').disabled = atCap;
  $('addBtn').title = atCap ? 'At the ' + MAX + '-flight limit — remove one first' : '';
}

// Never leave the list frozen on last-known values as though they were live:
// a stale reading that looks current is the failure this whole page exists to
// avoid making. The pill says when the data is from, and says so out loud when
// the fetch failed.
function stamp(ok){
  var d = new Date();
  var pill = $('freshPill');
  pill.textContent = ok ? 'updated ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : 'unreachable';
  pill.className = ok ? 'pill' : 'pill warn';
}

var timer = null, busy = false, disabled = false, atCap = false;

async function load(){
  var res = await fetch('/v1/tracked');
  if (res.status === 404) {
    // The server has no OpenSky credentials. Nothing here will start working
    // without a redeploy, so stop polling rather than reprinting the same 404
    // every twenty seconds.
    disabled = true;
    $('offCard').hidden = false;
    $('addCard').hidden = true;
    $('list').innerHTML = '<small class="help">Not available on this server.</small>';
    $('countPill').hidden = true;
    $('freshPill').className = 'pill';
    $('freshPill').textContent = 'disabled';
    return;
  }
  var j = await res.json();
  if (!j.ok) throw new Error(j.error || 'request failed');
  render(j.entries || []);
  stamp(true);
}

// Reschedules AFTER the response rather than on a fixed wall-clock interval, so
// a slow or hung request cannot stack a second poll on top of the first and let
// a stale answer land on a fresh one. Refresh calls straight in on top of the
// timer, so the in-flight guard bounds that path too.
async function poll(){
  clearTimeout(timer);
  if (busy || disabled) return;
  busy = true;
  try { await load(); }
  catch (err) { stamp(false); }
  finally {
    busy = false;
    if (!disabled) timer = setTimeout(poll, 20000);
  }
}

async function add(){
  var number = $('num').value.trim();
  var date = $('date').value;
  $('addErr').textContent = '';
  if (!number || !date) { $('addErr').textContent = 'Both a flight number and a date are needed.'; return; }

  $('addBtn').disabled = true;
  try {
    var res = await fetch('/v1/tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: number, date: date })
    });
    var j = await res.json();
    // routes.ts answers every rejection with a human reason -- the cap, the
    // date window, the shape of the number. Shown verbatim: rewording it here
    // is how the page and the server start disagreeing about the rules.
    if (!j.ok) { $('addErr').textContent = j.error || 'Could not add that flight.'; return; }
    $('num').value = '';
    $('num').focus();
  } catch (err) {
    $('addErr').textContent = 'Could not reach the server.';
  } finally {
    // Back to whatever the last successful render decided, NOT unconditionally
    // enabled: a POST that failed at the cap would otherwise re-arm the button
    // it is the whole point of, and stay armed until the next poll happened to
    // land. Never sticks disabled either -- Refresh re-polls, and a poll that
    // succeeds owns this again.
    $('addBtn').disabled = atCap;
    poll();
  }
}

async function del(id, number){
  if (!confirm('Stop watching ' + number + '?')) return;
  try {
    var res = await fetch('/v1/tracked/' + encodeURIComponent(id), { method: 'DELETE' });
    var j = await res.json();
    if (!j.ok) $('addErr').textContent = j.error || 'Could not remove that flight.';
  } catch (err) {
    $('addErr').textContent = 'Could not reach the server.';
  }
  poll();
}

$('addBtn').onclick = add;
$('refreshBtn').onclick = poll;
$('num').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') add(); });
$('date').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') add(); });

// Bounds taken from the server's own validation window, so the picker cannot
// offer a date the POST would reject.
$('date').min = utcDay(-WINDOW_PAST_DAYS);
$('date').max = utcDay(WINDOW_FUTURE_DAYS);
$('date').value = localDay(0);

poll();
</script>
</body>
</html>
`;
