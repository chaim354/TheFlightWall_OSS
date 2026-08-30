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
  input, select { width:100%; padding:9px 10px; background:#0e1420; border:1px solid var(--line); border-radius:8px; color:var(--fg); font:inherit; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  input[type=color] { padding:4px; height:38px; }
  /* Checkboxes opt OUT of the full-width input rule above, which otherwise
     stretches the box across the card and drops its label onto the next line
     -- the tick ends up centred over text it no longer looks attached to. */
  .check { display:flex; align-items:center; gap:8px; margin:8px 0; font-size:13px; color:var(--fg); }
  .check input[type=checkbox] { width:16px; height:16px; flex:0 0 auto; margin:0; accent-color:var(--accent); }
  .checks { display:flex; flex-wrap:wrap; gap:4px 18px; }
  .checks .check { flex:1 1 200px; margin:4px 0; }
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
  /* Lists inside help text. The browser default indents with padding-left:40px,
     which on a 12px muted paragraph reads as a stray column; 18px is enough to
     hang the marker and no more. */
  .help ul { margin:6px 0 0; padding-left:18px; }
  .help li { margin:3px 0; }
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
  <h1>FlightWall</h1>
  <span class="pill" id="countPill" hidden>…</span>
  <span class="spacer"></span>
  <span class="pill" id="freshPill" hidden>loading…</span>
  <button class="ghost" id="refreshBtn" hidden>Refresh</button>
  <button class="ghost" id="lockBtn" hidden>Lock</button>
</header>

<div class="wrap">

  <div class="card" id="lockCard">
    <h2>Sign in</h2>
    <div class="line">This page watches flights and controls the wall. If nobody has changed it, the
      shipped password is <b>flightwall123</b> — a page cannot tell you whether that still works without
      being given it, so it says what it shipped with rather than guessing.</div>
    <label for="pw" style="display:block;font-size:12px;color:var(--muted);margin:12px 0 4px">Password</label>
    <input id="pw" type="password" autocomplete="current-password" />
    <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button id="unlockBtn">Unlock</button></div></div>
    <div class="err" id="lockErr"></div>
  </div>

<div id="app" hidden>

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
      <div style="flex:0 0 90px">
        <label for="from">From</label>
        <input id="from" placeholder="JFK" maxlength="3" autocomplete="off" spellcheck="false" autocapitalize="characters" />
      </div>
      <div style="flex:0 0 90px">
        <label for="to">To</label>
        <input id="to" placeholder="LHR" maxlength="3" autocomplete="off" spellcheck="false" autocapitalize="characters" />
      </div>
      <div style="flex:0 0 auto">
        <button id="addBtn">Watch</button>
      </div>
    </div>
    <div class="err" id="addErr"></div>
    <small class="help">One journey, not a subscription: a flight number plus the single date it departs.
      The date is the one <b>on the boarding pass</b> — local to the departure airport, so a 20:55
      departure from JFK is the 24th even though it is already the 25th in UTC. Watching costs nothing
      until that date begins: the flight is looked up then, and again an hour before it leaves, to
      catch a tail swap.</small>
    <small class="help"><b>From / To are optional, and worth filling in.</b> A flight number is not
      unique within a day — an airline reuses it for the return leg and for the next hop of a
      rotation. With the route blank the lookup has to guess which one you mean, and it guesses by
      the clock, so an evening departure added the night before resolves to that morning's flight
      instead. Either box on its own is enough to settle it. Give both legs their own route and you
      can watch a there-and-back on the same date.</small>
    <!-- div, not small: this block contains a <ul>, which is flow content and
         so not allowed inside <small>'s phrasing-only content model. .help
         already sets display:block and the font size, so the two style
         identically -- this is a validity fix, not a visual choice. -->
    <div class="help"><b>When it reaches the wall.</b> At the flight's <b>scheduled departure</b>,
      within one five-minute cycle — not at wheels-up. It is then pinned above the overhead traffic
      until it lands. Three things follow from that, and they are worth knowing before you read the
      card:
      <ul>
        <li>A <b>delayed</b> flight is pinned anyway, while it is still at the gate. Until ADS-B
          picks the aircraft up, its position is a projection along the great-circle route — so the
          wall can show it out over the ocean when it has not moved.</li>
        <li>The <b>progress bar and the ETA both read the published timetable</b>, never the live
          position. That is why they always agree with each other, and why a late departure makes
          both of them run ahead of where the aeroplane really is.</li>
        <li>If the lookup found no Mode&nbsp;S address for the aircraft — common on regional
          flights — nothing is pinned at departure. Live ADS-B is swept for whatever is broadcasting
          that number near where the schedule puts it, and the card appears once that finds
          something.</li>
      </ul>
      <b>It goes away</b> as soon as ADS-B reports the aircraft on the ground, or 30 minutes past
      the scheduled arrival if nothing ever does. The entry itself is removed about two hours after
      that, so a landed flight stops costing anything without you touching it.</div>
  </div>

  <div class="card">
    <h2>Watching</h2>
    <div id="list"><small class="help">loading…</small></div>
  </div>

  <div id="ctl" hidden>
    <div class="card" id="defaultWarn" hidden style="border-color:var(--warn)">
      <h2 style="color:var(--warn)">Still using the default password</h2>
      <div class="line"><b>Anyone who finds this URL can change your wall's settings and restart it.</b>
        The address is public. Set a password below — it takes one field and it is the only thing standing
        between the internet and your living room.</div>
    </div>

    <div class="card" data-tier="admin">
      <h2>What the wall last reported <span class="pill" data-lock>admin</span></h2>
      <div id="wallStatus"></div>
    </div>

    <small class="help" id="ctlNote" style="text-align:center"></small>

    <div class="card" data-tier="ui">
      <h2>Brightness</h2>
      <div class="row">
        <div><label>Base (0–255)</label><input id="f_display_brightness" type="number" min="0" max="255" /></div>
        <div><label>Day</label><input id="f_schedule_dayBrightness" type="number" min="0" max="255" /></div>
        <div><label>Night</label><input id="f_schedule_nightBrightness" type="number" min="0" max="255" /></div>
      </div>
      <div class="row">
        <div><label>Night starts (0–23)</label><input id="f_schedule_nightStartHour" type="number" min="0" max="23" /></div>
        <div><label>Night ends (0–23)</label><input id="f_schedule_nightEndHour" type="number" min="0" max="23" /></div>
        <div><label>Time zone</label>
          <select id="f_schedule_timezone">
            <option value="UTC0">UTC</option>
            <option value="EST5EDT,M3.2.0,M11.1.0">US Eastern (New York)</option>
            <option value="CST6CDT,M3.2.0,M11.1.0">US Central (Chicago)</option>
            <option value="MST7MDT,M3.2.0,M11.1.0">US Mountain (Denver)</option>
            <option value="MST7">US Arizona (no DST)</option>
            <option value="PST8PDT,M3.2.0,M11.1.0">US Pacific (Los Angeles)</option>
            <option value="AKST9AKDT,M3.2.0,M11.1.0">US Alaska</option>
            <option value="HST10">US Hawaii (no DST)</option>
            <option value="GMT0BST,M3.5.0/1,M10.5.0">UK (London)</option>
            <option value="CET-1CEST,M3.5.0,M10.5.0/3">Central Europe (Berlin/Paris)</option>
          </select></div>
      </div>
      <span class="check"><input type="checkbox" id="f_schedule_enabled" /> Day/night schedule enabled</span>
      <small class="help">With the schedule on, day and night win over the base value — so changing the
        base alone can look like nothing happened.</small>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="display,schedule">Save</button></div></div>
    </div>

    <div class="card" data-tier="ui">
      <h2>Display</h2>
      <div class="row">
        <div><label>Seconds per flight</label><input id="f_display_cycleSeconds" type="number" min="1" /></div>
        <div><label>Max flights</label><input id="f_display_maxFlights" type="number" min="1" max="20" /></div>
      </div>
      <label>When no flights</label>
      <select id="f_layout_noFlightsMode">
        <option value="dots">Dots</option><option value="clock">Clock</option>
        <option value="funfact">Fun fact</option><option value="clockfact">Clock + fun fact</option>
      </select>
      <div class="checks" style="margin-top:8px">
        <span class="check"><input type="checkbox" id="f_layout_showAirlineFlight" /> Airline + flight</span>
        <span class="check"><input type="checkbox" id="f_layout_showRoute" /> Route</span>
        <span class="check"><input type="checkbox" id="f_layout_showEta" /> ETA</span>
        <span class="check"><input type="checkbox" id="f_layout_showAircraft" /> Aircraft</span>
        <span class="check"><input type="checkbox" id="f_layout_showAltitude" /> Altitude</span>
        <span class="check"><input type="checkbox" id="f_layout_showSpeed" /> Speed</span>
        <span class="check"><input type="checkbox" id="f_layout_showHeading" /> Heading</span>
        <span class="check"><input type="checkbox" id="f_layout_showVerticalRate" /> Vertical rate</span>
        <span class="check"><input type="checkbox" id="f_layout_flightNumberOverVr" /> Flight # over vertical rate</span>
      </div>
      <div class="row" style="margin-top:10px">
        <div style="flex:0 0 150px"><label>Text colour</label><input id="f_display_textColor" type="color" /></div>
        <div><span class="check" style="margin-top:18px"><input type="checkbox" id="f_buttons_enabled" /> Physical buttons enabled</span></div>
      </div>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="display,layout,buttons">Save</button></div></div>
    </div>

    <div class="card" data-tier="ui">
      <h2>Tracking &amp; filters</h2>
      <div class="row">
        <div><label>Centre latitude</label><input id="f_tracking_centerLat" type="number" step="0.0001" /></div>
        <div><label>Centre longitude</label><input id="f_tracking_centerLon" type="number" step="0.0001" /></div>
        <div><label>Radius (km)</label><input id="f_tracking_radiusKm" type="number" step="0.5" /></div>
      </div>
      <div class="row">
        <div><label>Mode</label>
          <select id="f_tracking_mode"><option value="area">Area around the centre</option><option value="flights">Watched flights only</option></select></div>
      </div>
      <span class="check"><input type="checkbox" id="f_tracking_autoLocateOnBoot" /> Re-locate the centre on boot</span>
      <div class="row">
        <div><label>Min altitude (ft)</label><input id="f_filters_minAltitudeFt" type="number" /></div>
        <div><label>Max altitude (ft)</label><input id="f_filters_maxAltitudeFt" type="number" /></div>
      </div>
      <span class="check"><input type="checkbox" id="f_filters_excludeOnGround" /> Hide aircraft on the ground</span>
      <span class="check"><input type="checkbox" id="f_filters_showGeneralAviation" /> Show general aviation / private</span>
      <span class="check"><input type="checkbox" id="f_filters_hideCargo" /> Hide cargo / freight</span>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="tracking,filters">Save</button></div></div>
    </div>

    <div class="card" data-tier="admin">
      <h2>Sources &amp; keys <span class="pill" data-lock>admin</span></h2>
      <div class="row">
        <div><label>Position source</label>
          <select id="f_api_positionSource">
            <option value="opensky">OpenSky</option><option value="fr24">Flightradar24</option>
            <option value="adsblol">adsb.lol</option><option value="server">FlightWall server</option>
          </select></div>
        <div><label>Enrichment source</label>
          <select id="f_api_enrichmentSource">
            <option value="adsbdb">adsbdb</option><option value="aeroapi">AeroAPI</option><option value="off">Off</option>
          </select></div>
        <div><label>Fetch interval (s)</label><input id="f_display_fetchIntervalSeconds" type="number" min="5" /></div>
      </div>
      <label>FlightAware AeroAPI key</label>
      <input id="f_api_aeroApiKey" type="password" placeholder="leave blank to keep the stored one" />
      <div class="row">
        <div><label>OpenSky client id</label><input id="f_api_openSkyClientId" /></div>
        <div><label>OpenSky client secret</label><input id="f_api_openSkyClientSecret" type="password" placeholder="leave blank to keep the stored one" /></div>
        <div><label>Enrichment cache (s)</label><input id="f_api_enrichmentCacheSeconds" type="number" min="0" /></div>
      </div>
      <span class="check"><input type="checkbox" id="f_api_enrichmentFallbackToAeroApi" /> Use AeroAPI as backup when adsbdb misses</span>
      <small class="help">These decide where data comes from and what it costs. The fetch interval is also
        how long a queued change waits before the wall collects it.</small>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="api,display">Save</button></div></div>
    </div>

    <div class="card" data-tier="ui">
      <h2>Light sensor</h2>
      <span class="check"><input type="checkbox" id="f_light_enabled" /> Use the light sensor</span>
      <div class="row">
        <div><label>Dark threshold</label><input id="f_light_darkThreshold" type="number" /></div>
        <div><label>Hysteresis</label><input id="f_light_hysteresis" type="number" /></div>
        <div><label>Dim brightness</label><input id="f_light_dimBrightness" type="number" min="0" max="255" /></div>
      </div>
      <span class="check"><input type="checkbox" id="f_light_dimInstead" /> Dim instead of switching off</span>
      <small class="help">Turning the sensor off leaves the wall on the brightness above, which is the
        quickest fix for a panel that has gone dark and should not have. A threshold set too high does
        the same thing on its own — the wall blanks and pauses fetching, and from here that looks exactly
        like a dead device. Hysteresis is the margin either side of the threshold that stops it flapping
        on and off at dusk; raise it if the wall dithers, and leave it alone otherwise.</small>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="light">Save</button></div></div>
    </div>

    <div class="card" data-tier="admin">
      <h2>Light sensor wiring <span class="pill" data-lock>admin</span></h2>
      <div class="row">
        <div><label>Type</label>
          <select id="f_light_type">
            <option value="analog">Analog LDR</option><option value="bh1750">BH1750</option><option value="tcs3472">TCS3472</option>
          </select></div>
        <div><label>Analog pin</label><input id="f_light_pin" type="number" /></div>
      </div>
      <small class="help">Which sensor it is and where it is plugged in. Wrong here and the wall reads
        darkness off an unconnected pin, which blanks the panel and pauses fetching.</small>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="light">Save</button></div></div>
    </div>

    <div class="card" data-tier="admin">
      <h2>HUB75 panel <span class="pill" data-lock>admin</span></h2>
      <div class="row">
        <div><label>Panel width</label><input id="f_hardware_panelResX" type="number" /></div>
        <div><label>Panel height</label><input id="f_hardware_panelResY" type="number" /></div>
        <div><label>Chained</label><input id="f_hardware_panelChain" type="number" min="1" /></div>
      </div>
      <div class="row">
        <div><label>Driver chip</label>
          <select id="f_hardware_panelDriverChip">
            <option value="shift">Generic shift register</option><option value="fm6126a">FM6126A</option>
            <option value="fm6124">FM6124</option><option value="icn2038s">ICN2038S</option><option value="mbi5124">MBI5124</option>
          </select></div>
        <div><label>I2S clock (MHz)</label>
          <select id="f_hardware_panelI2sSpeedMhz"><option value="8">8</option><option value="16">16</option><option value="20">20</option></select></div>
        <div><label>Latch blanking</label><input id="f_hardware_panelLatchBlanking" type="number" min="1" max="4" /></div>
      </div>
      <span class="check"><input type="checkbox" id="f_hardware_panelClkPhase" /> Clock phase</span>
      <small class="help"><b>Wrong values blank or scramble the display</b>, and they only take effect after a
        restart — so a mistake here is a dark wall until someone walks over to it.</small>
      <div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button data-send="hardware">Save</button></div></div>
    </div>

    <div class="card" data-tier="admin">
      <h2>Flash &amp; restart <span class="pill" data-lock>admin</span></h2>
      <div class="row">
        <div style="flex:0 0 auto"><button class="ghost" data-action="updateui">Update web UI</button></div>
        <div style="flex:0 0 auto"><button class="ghost" data-action="updatefw">Update firmware</button></div>
        <div style="flex:0 0 auto"><button class="danger" data-action="restart">Restart the wall</button></div>
      </div>
      <small class="help">Firmware images are signature-checked on the device; one that does not verify is
        refused and the wall keeps running what it has.</small>
    </div>

    <div class="card">
      <h2>Passwords</h2>
      <div class="row">
        <div><label>New wall-control password</label><input id="newUiPw" type="password" autocomplete="new-password" /></div>
        <div style="flex:0 0 auto"><button class="ghost" data-pw="ui">Set</button></div>
      </div>
      <div class="row" style="margin-top:6px" id="adminPwRow">
        <div><label id="adminPwLabel">New admin password</label><input id="newAdminPw" type="password" autocomplete="new-password" /></div>
        <div style="flex:0 0 auto"><button class="ghost" data-pw="admin">Set</button></div>
      </div>
      <small class="help">At least 8 characters. The <b>device's</b> own token is separate and deliberately
        not settable here — changing it would leave the wall unable to check in, with no way back but a cable.</small>
      <div class="err" id="pwErr"></div>
    </div>

    <div class="card">
      <h2>Queued, not yet collected</h2>
      <div id="pending"></div>
      <div class="err" id="ctlErr"></div>
    </div>
  </div>

  <small class="help" id="adminHint" style="text-align:center" hidden>Some settings — flashing, updates,
    restarts, the panel and the light sensor — need the admin password. Press <b>Lock</b> and sign in
    with it to see them.</small>

</div><!-- #app -->

</div>

<script>
// Declared first because the watched-flight calls above the control block read
// it too: one credential for the whole page, not one per section.
var SECRET_KEY = 'flightwall.secret';
var secret = sessionStorage.getItem(SECRET_KEY) || '';

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
  // Before the lookup runs there is no resolved route to show, and what the
  // person typed is the only thing on the card that says WHICH leg this is --
  // which matters most exactly here, because a transposed pair of codes is
  // invisible until the resolve fails hours later. Shown only while unresolved:
  // once origIata exists it is the same information, confirmed.
  else if (e.wantOrigIata || e.wantDestIata)
    bits.push('asked for <b>' + esc(e.wantOrigIata || '*') + ' → ' + esc(e.wantDestIata || '*') + '</b>');
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
       '<span class="pill">' + esc(e.date) + '</span>' +
       // Provenance, because it decides who may remove this entry. A
       // calendar-sourced entry comes back on the next sync if you delete it
       // here and it is still in the feed, and vanishes on its own when it
       // leaves the feed -- neither of which makes sense without the marker.
       // Entries stored before the source field existed report nothing rather
       // than claiming to be hand-added. No backticks in here: this comment
       // lives inside the page's own template literal, and one would end it.
       (e.source === 'calendar' ? '<span class="pill">calendar</span>' : '') +
       (e.source === 'manual' ? '<span class="pill">by hand</span>' : '') +
       '</div>' +
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
// The watched-flight poll does not start until a password is in hand.
var polling = false;

// Every call carries the password. The watched-flight routes are gated behind
// the same credential as the wall controls, so a page that hides its contents
// while leaving the API open would be a curtain, not a lock.
function authed(extra) {
  var h = extra || {};
  h.authorization = 'Bearer ' + secret;
  return h;
}

async function load(){
  var res = await fetch('/v1/tracked', { headers: authed() });
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
  // Sent as typed, blanks included. Validation is the server's -- routes.ts
  // answers with a reason and this page prints it verbatim, for the same
  // reason the error below is not reworded: two implementations of the rules
  // is how a form starts accepting what the endpoint rejects.
  var from = $('from').value.trim();
  var to = $('to').value.trim();
  $('addErr').textContent = '';
  if (!number || !date) { $('addErr').textContent = 'Both a flight number and a date are needed.'; return; }

  $('addBtn').disabled = true;
  try {
    var res = await fetch('/v1/tracked', {
      method: 'POST',
      headers: authed({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ number: number, date: date, from: from, to: to })
    });
    var j = await res.json();
    // routes.ts answers every rejection with a human reason -- the cap, the
    // date window, the shape of the number. Shown verbatim: rewording it here
    // is how the page and the server start disagreeing about the rules.
    if (!j.ok) { $('addErr').textContent = j.error || 'Could not add that flight.'; return; }
    $('num').value = '';
    $('from').value = '';
    $('to').value = '';
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
    var res = await fetch('/v1/tracked/' + encodeURIComponent(id), { method: 'DELETE', headers: authed() });
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

/* ------------------------------------------------------------------ *
 * Wall control
 *
 * Same page, different trust level. Watched flights are open to anyone
 * who can reach the URL; everything below needs a password, and the
 * things that can brick the wall or spend money need a second one.
 * ------------------------------------------------------------------ */

// sessionStorage rather than a variable: a refresh in the middle of
// adjusting the wall should not throw the password away, and rather than
// localStorage so closing the tab ends it.
var tier = 'none';
var ctlTimer = null;

// Fields the person is currently editing. Polling repopulates the form
// from what the wall reports, and without this a value would be yanked
// back out from under a half-typed number every few seconds.
var touched = {};

function fields() { return document.querySelectorAll('#ctl [id^="f_"]'); }

// f_display_brightness -> ['display','brightness']. Section names have no
// underscores and neither do the keys, so a plain split is enough.
function fieldPath(id) { var p = id.split('_'); return [p[1], p.slice(2).join('_')]; }

function rgbToHex(r, g, b) {
  function h(n) { n = Math.max(0, Math.min(255, Number(n) || 0)); return (n < 16 ? '0' : '') + n.toString(16); }
  return '#' + h(r) + h(g) + h(b);
}

function populate(settings) {
  if (!settings) return;
  var els = fields();
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (touched[el.id]) continue;

    var path = fieldPath(el.id);
    var section = settings[path[0]];
    if (!section) continue;

    // The colour picker is one control over three stored channels.
    if (el.id === 'f_display_textColor') {
      el.value = rgbToHex(section.textColorR, section.textColorG, section.textColorB);
      continue;
    }

    var v = section[path[1]];
    if (v === undefined || v === null) continue;

    if (el.tagName === 'SELECT') {
      // Assigning a value a <select> has no option for silently leaves it on
      // the first option -- and the next Save would then write THAT, replacing
      // the wall's real setting with the top of a list nobody chose. The
      // device stores these four verbatim (timezone, no-flights mode, driver
      // chip, I2S clock), so its value can legitimately be one this page has
      // never heard of. Keep it, labelled, exactly as the LAN page does.
      el.value = String(v);
      if (el.value !== String(v)) {
        var opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = 'Custom — ' + String(v);
        el.appendChild(opt);
        el.value = String(v);
      }
      continue;
    }

    if (el.type === 'checkbox') el.checked = !!v;
    // A stored secret comes back redacted or absent; leaving the box empty
    // is what makes "blank means keep it" true rather than destructive.
    else if (el.type === 'password') el.value = '';
    else el.value = v;
  }
}

// Scoped to the card the button lives in, NOT to the whole form.
//
// Gathering by section name across the page looks equivalent and is not: a
// section's fields are spread over several cards -- display.fetchIntervalSeconds
// sits with the API keys because it decides how often they are spent -- so a
// page-wide sweep made "Queue display" also submit an admin-only field, and the
// whole card was refused for a control the person never touched.
function collect(card, sections) {
  var want = {};
  for (var i = 0; i < sections.length; i++) want[sections[i]] = 1;

  var set = {};
  var els = card.querySelectorAll('[id^="f_"]');
  for (var j = 0; j < els.length; j++) {
    var el = els[j];
    var path = fieldPath(el.id);
    if (!want[path[0]]) continue;

    if (el.id === 'f_display_textColor') {
      var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(el.value || '');
      if (!m) continue;
      set.display = set.display || {};
      set.display.textColorR = parseInt(m[1], 16);
      set.display.textColorG = parseInt(m[2], 16);
      set.display.textColorB = parseInt(m[3], 16);
      continue;
    }

    var v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') { if (el.value === '') continue; v = Number(el.value); if (isNaN(v)) continue; }
    else { v = el.value; if (el.type === 'password' && v === '') continue; }

    set[path[0]] = set[path[0]] || {};
    set[path[0]][path[1]] = v;
  }
  return set;
}

async function ctlPost(path, body) {
  var res = await fetch('/v1/control' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
    body: JSON.stringify(body),
  });
  var text = await res.text();
  var j = {};
  try { j = JSON.parse(text); } catch (e) { j = { error: text }; }
  return { status: res.status, body: j };
}

async function send(card, sectionList) {
  var set = collect(card, sectionList.split(','));
  if (Object.keys(set).length === 0) { $('ctlErr').textContent = 'Nothing filled in to send.'; return; }
  var r = await ctlPost('/command', { set: set });
  if (r.status === 201) {
    $('ctlErr').textContent = '';
    // Cleared so the next poll shows what the wall actually took, rather
    // than leaving the form frozen on what was asked for.
    touched = {};
  } else {
    $('ctlErr').textContent = r.body.error || ('Refused (' + r.status + ')');
  }
  pollCtl();
}

async function doAction(action) {
  var what = action === 'restart' ? 'Restart the wall?'
    : action === 'updatefw' ? 'Tell the wall to fetch and flash new firmware?'
    : 'Tell the wall to fetch a new web UI?';
  if (!confirm(what + ' It runs at the next check-in.')) return;
  var r = await ctlPost('/command', { action: action });
  $('ctlErr').textContent = r.status === 201 ? '' : (r.body.error || ('Refused (' + r.status + ')'));
  pollCtl();
}

async function setPassword(which) {
  var el = which === 'ui' ? $('newUiPw') : $('newAdminPw');
  var pw = el.value;
  if (pw.length < 8) { $('pwErr').textContent = 'At least 8 characters.'; return; }
  var r = await ctlPost('/password', { which: which, newPassword: pw });
  if (r.status !== 200) { $('pwErr').textContent = r.body.error || ('Refused (' + r.status + ')'); return; }
  el.value = '';
  $('pwErr').textContent = '';
  // Adopt the new password only when it replaces the one we are actually
  // holding, or when it is the first admin password (which upgrades us).
  //
  // The case this guards is changing the UI password while holding ADMIN:
  // adopting there swaps a working admin credential for a weaker one and
  // demotes the page mid-session, with every admin control greying out and
  // nothing on screen saying why.
  var replacesOurs = tier === which || (which === 'admin' && tier === 'ui');
  if (replacesOurs) {
    secret = pw;
    sessionStorage.setItem(SECRET_KEY, pw);
  }
  pollCtl();
}

// Admin cards are removed from the page, not greyed out.
//
// Disabling them still renders every field the wall reports, and the values
// were the sensitive part -- the API credentials, the panel geometry. The
// server stops sending those to a non-admin caller, so a visible card would
// only ever show blanks anyway. A short hint keeps the tier discoverable
// without naming anything inside it.
function applyTier(adminAvailable, hasSettings) {
  var locked = tier !== 'admin';
  var cards = document.querySelectorAll('#ctl [data-tier]');
  for (var i = 0; i < cards.length; i++) {
    // Two reasons a settings card stays away, resolved together: the tier may
    // not see it, or the wall has never said what to put in it. Deciding them
    // in two functions meant whichever ran last won, and renderStatus ran last.
    var isAdmin = cards[i].getAttribute('data-tier') === 'admin';
    // The second rule applies only to cards that WOULD be populated. The
    // status card has no fields, and "the wall has not checked in yet" is
    // exactly what an admin needs to see when there are no settings.
    var needsSettings = cards[i].querySelector('[id^="f_"]') !== null;
    cards[i].hidden = (isAdmin && locked) || (needsSettings && !hasSettings);
    var pill = cards[i].querySelector('[data-lock]');
    if (pill) { pill.textContent = 'admin'; pill.className = 'pill on'; }
  }
  $('adminHint').hidden = !(locked && adminAvailable);

  // The admin password row: settable by the ui tier only to create the FIRST
  // one, and after that only by whoever holds it.
  var canSetAdmin = !adminAvailable || tier === 'admin';
  $('adminPwRow').hidden = !canSetAdmin;
  $('adminPwLabel').textContent = adminAvailable
    ? 'Change the admin password' : 'Set an admin password (unlocks flashing, the panel and the sensor)';
}

function renderStatus(st, ageMs) {
  if (!st) {
    $('wallStatus').innerHTML = '<div class="line warn">The wall has not checked in yet.</div>';
    $('ctlNote').textContent = '';
    return;
  }
  // Age, not a timestamp: the reader is asking "is it alive", and a clock
  // reading makes them do the subtraction against a device that may be in
  // another time zone.
  var age = ageMs === null || ageMs === undefined ? '?' : fmtAge(ageMs);
  var stale = ageMs !== null && ageMs !== undefined && ageMs > 5 * 60 * 1000;
  var bits = [
    ['Heard from', age + ' ago'],
    ['Firmware', st.fwVersion || '?'],
    ['Address', st.ip || '?'],
    ['Signal', st.rssi === undefined ? '?' : st.rssi + ' dBm'],
    ['Showing', (st.flightCount === undefined ? '?' : st.flightCount) + ' flights'],
    ['Brightness', st.panelOff ? 'panel off' : (st.brightness === undefined ? '?' : String(st.brightness))],
    ['Uptime', st.uptimeS === undefined ? '?' : fmtAge(st.uptimeS * 1000)],
  ];
  var html = '<div class="row">';
  for (var i = 0; i < bits.length; i++) {
    html += '<div><label>' + esc(bits[i][0]) + '</label><div>' + esc(String(bits[i][1])) + '</div></div>';
  }
  html += '</div>';
  if (stale) html += '<div class="line warn" style="margin-top:8px"><b>That is old.</b> Anything queued below will sit unclaimed until the wall comes back.</div>';
  if (st.note) html += '<div class="line" style="margin-top:8px">' + esc(st.note) + '</div>';
  $('wallStatus').innerHTML = html;


}

function fmtAge(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function renderPending(pending) {
  if (!pending || pending.length === 0) {
    $('pending').innerHTML = '<div class="line">Nothing waiting. The wall collects commands on its next fetch.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < pending.length; i++) {
    var c = pending[i];
    var what = c.action ? c.action : JSON.stringify(c.set || {});
    html += '<div class="line">' + esc(what) + '</div>';
  }
  $('pending').innerHTML = html;
}

async function pollCtl() {
  if (!secret) return;
  var res;
  try {
    res = await fetch('/v1/control', { headers: { authorization: 'Bearer ' + secret } });
  } catch (e) { $('ctlErr').textContent = 'Could not reach the server.'; return; }

  if (res.status === 401 || res.status === 403) {
    // The password changed under us, or was never right.
    secret = '';
    sessionStorage.removeItem(SECRET_KEY);
    showLocked('That password is no longer accepted.');
    return;
  }
  if (res.status === 404) { $('lockCard').hidden = true; return; } // control disabled server-side

  var j = await res.json();
  tier = j.tier || 'none';
  $('lockCard').hidden = true;
  $('app').hidden = false;
  $('ctl').hidden = false;
  for (var h = 0; h < HEADER_BITS.length; h++) $(HEADER_BITS[h]).hidden = false;
  if (!polling) { polling = true; poll(); }
  $('defaultWarn').hidden = !j.usingDefaultUiPassword;
  var hasSettings = !!(j.status && j.status.settings);
  $('ctlNote').textContent = hasSettings ? ''
    : 'The wall has not reported its settings yet, so its controls are hidden — sending a form full of blanks would overwrite real values with guesses.';
  applyTier(!!j.adminAvailable, hasSettings);
  renderStatus(j.status, j.statusAgeMs);
  if (j.status && j.status.settings) populate(j.status.settings);
  renderPending(j.pending);

  if (ctlTimer) clearTimeout(ctlTimer);
  ctlTimer = setTimeout(pollCtl, 10000);
}

async function unlock() {
  secret = $('pw').value;
  if (!secret) return;
  sessionStorage.setItem(SECRET_KEY, secret);
  $('lockErr').textContent = '';
  $('pw').value = '';
  await pollCtl();
}

// Locking is also how someone SWITCHES password: the admin sections are
// reachable from the ui tier only by signing back in with the admin one, and
// without this the page has no way to offer that short of clearing storage.
// The header pills and buttons are as much "signed in" state as the cards are;
// a count of watched flights beside a sign-in prompt says how many there are.
var HEADER_BITS = ['countPill', 'freshPill', 'refreshBtn', 'lockBtn'];

function showLocked(message) {
  secret = '';
  tier = 'none';
  sessionStorage.removeItem(SECRET_KEY);
  if (ctlTimer) clearTimeout(ctlTimer);
  if (timer) clearTimeout(timer);
  polling = false;
  $('app').hidden = true;
  $('ctl').hidden = true;
  for (var h = 0; h < HEADER_BITS.length; h++) $(HEADER_BITS[h]).hidden = true;
  $('lockCard').hidden = false;
  $('lockErr').textContent = message || '';
  window.scrollTo(0, 0);
}

function lock() { showLocked(''); }

$('lockBtn').onclick = lock;
$('unlockBtn').onclick = unlock;
$('pw').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') unlock(); });

document.addEventListener('input', function(ev){
  var el = ev.target;
  if (el && el.id && el.id.indexOf('f_') === 0) touched[el.id] = 1;
});
document.addEventListener('click', function(ev){
  var el = ev.target;
  if (!el || !el.getAttribute) return;
  if (el.getAttribute('data-send')) send(el.closest('.card'), el.getAttribute('data-send'));
  else if (el.getAttribute('data-action')) doAction(el.getAttribute('data-action'));
  else if (el.getAttribute('data-pw')) setPassword(el.getAttribute('data-pw'));
});

if (secret) pollCtl();
else showLocked('');
</script>
</body>
</html>
`;
