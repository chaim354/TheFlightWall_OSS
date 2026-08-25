import { describe, it, expect } from 'vitest';
import { trackedPage } from '../../src/tracked/page';
import { adminFieldsIn } from '../../src/controlAuth';

/**
 * The page and the server's permission model are two lists of the same field
 * names, kept in different files and different languages. Nothing makes them
 * agree except these tests: put a field in the wrong card and the page offers
 * a control that the server refuses, which reads as a broken page rather than
 * as the permission check it is.
 */

/** Every settings input, as [id, section, key]. */
function fieldIds(html: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const m of html.matchAll(/id="(f_([a-zA-Z]+)_([a-zA-Z0-9]+))"/g)) {
    out.push([m[1]!, m[2]!, m[3]!]);
  }
  return out;
}

/** The <div class="card" ...> ... </div> blocks, sliced on the opening tags. */
function cards(html: string): string[] {
  return html.split(/<div class="card"/).slice(1);
}

describe('the merged watched-flights and control page', () => {
  it('carries both concerns, so there is one address for the wall', () => {
    expect(trackedPage).toContain('id="lockCard"');
    expect(trackedPage).toContain('Watch a flight');
    expect(trackedPage).toContain('/v1/control');
    expect(trackedPage).toContain('/v1/tracked');
  });

  it('puts the sign-in card ahead of everything it protects', () => {
    // Ordering IS the gate here: #app wraps the rest and starts hidden, so a
    // card that drifted above the wrapper would render to a stranger.
    const lock = trackedPage.indexOf('id="lockCard"');
    const app = trackedPage.indexOf('<div id="app" hidden>');
    expect(lock).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(lock);
    for (const id of ['id="addCard"', 'id="ctl"', 'id="list"', 'id="pending"']) {
      expect(trackedPage.indexOf(id), `${id} is outside #app`).toBeGreaterThan(app);
    }
  });

  it('sends the password with every watched-flight call', () => {
    // The API is gated server-side now; an unauthenticated fetch here would
    // 401 and read as "the feature is broken".
    // By line rather than by regex over the whole call: encodeURIComponent(id)
    // closes the first paren, so a naive [^)]* match ends before the headers.
    const lines = trackedPage.split('\n');
    const sites = lines
      .map((line, i) => [line, lines.slice(i, i + 4).join('\n')] as const)
      .filter(([line]) => line.includes("fetch('/v1/tracked"));
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const [line, block] of sites) {
      expect(block, `unauthenticated: ${line.trim()}`).toContain('authed(');
    }
  });

  it('offers no field that would strand the wall', () => {
    // Wi-Fi credentials and the device's own token are stripped by the server
    // AND by the firmware; a page that offers them is offering a control that
    // silently does nothing, which is worse than not offering it.
    for (const forbidden of ['f_network_', 'f_api_controlToken', 'wifiSsid', 'wifiPassword']) {
      expect(trackedPage).not.toContain(forbidden);
    }
  });

  it('puts every admin-gated field inside an admin card and nothing else', () => {
    const adminCards = cards(trackedPage).filter((c) => c.startsWith(' data-tier="admin"'));
    const inAdminCard = new Set(adminCards.flatMap((c) => fieldIds(c).map(([id]) => id)));

    for (const [id, section, key] of fieldIds(trackedPage)) {
      // Ask the server's own rule rather than restating it here.
      const needsAdmin = adminFieldsIn({ [section]: { [key]: 1 } }).length > 0;
      expect(
        inAdminCard.has(id),
        `${id} is ${needsAdmin ? '' : 'not '}admin-gated on the server but is ${
          inAdminCard.has(id) ? '' : 'not '}in an admin card`,
      ).toBe(needsAdmin);
    }
  });

  it('gates every action button behind the admin tier', () => {
    const adminCards = cards(trackedPage).filter((c) => c.startsWith(' data-tier="admin"'));
    const actions = [...trackedPage.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]!);
    expect(actions.sort()).toEqual(['restart', 'updatefw', 'updateui']);
    for (const a of actions) {
      expect(adminCards.some((c) => c.includes(`data-action="${a}"`)), `${a} is not admin-gated`).toBe(true);
    }
  });

  it('names exactly the sections its own card holds, in both directions', () => {
    // Both directions, because each failure is silent in its own way. A named
    // section with no field in the card sends nothing; a field whose section is
    // unnamed is edited on screen and then quietly dropped on submit.
    for (const card of cards(trackedPage)) {
      const send = /data-send="([a-z,]+)"/i.exec(card);
      if (!send) continue;
      const named = new Set(send[1]!.split(','));
      const present = new Set(fieldIds(card).map(([, section]) => section));
      expect([...named].sort(), `card sends ${[...named]} but holds ${[...present]}`)
        .toEqual([...present].sort());
    }
  });

  it('leaves no settings field outside a card that can submit it', () => {
    // An input nobody's button collects is a control that looks live and does
    // nothing -- the failure mode the fetchIntervalSeconds bug produced.
    const submittable = new Set(
      cards(trackedPage)
        .filter((c) => /data-send="/.test(c))
        .flatMap((c) => fieldIds(c).map(([id]) => id)),
    );
    for (const [id] of fieldIds(trackedPage)) {
      expect(submittable.has(id), `${id} has no button that submits it`).toBe(true);
    }
  });

  it('offers the timezone as named zones, not a POSIX string to type', () => {
    // The device stores a POSIX TZ spec. A free-text box invited an IANA name
    // like "America/New_York", which libc cannot parse -- the wall would fall
    // back to UTC and the day/night schedule would drift by hours with nothing
    // on screen to say why.
    const tz = /<select id="f_schedule_timezone">([\s\S]*?)<\/select>/.exec(trackedPage);
    expect(tz, 'timezone is not a select').not.toBeNull();
    const values = [...tz![1]!.matchAll(/value="([^"]*)"/g)].map((m) => m[1]!);
    expect(values).toContain('EST5EDT,M3.2.0,M11.1.0');
    expect(values.length).toBeGreaterThanOrEqual(10);
    // No IANA names. A slash alone does not distinguish them -- a POSIX spec
    // uses one for the DST transition hour, as in "M3.5.0/1" -- so match the
    // Area/City shape instead.
    for (const v of values) expect(v, `${v} looks like an IANA name`).not.toMatch(/^[A-Za-z_]+\/[A-Za-z_]+$/);
  });

  it('keeps a select value the page has no option for', () => {
    // Assigning an unknown value to a <select> silently leaves it on the first
    // option, and the next Save writes THAT -- replacing the wall's real
    // setting with the top of a list nobody chose. Four fields are stored
    // verbatim by the device and can hold values this page never listed.
    expect(trackedPage).toContain("if (el.value !== String(v))");
    expect(trackedPage).toContain("'Custom — '");
  });

  it('keeps the wall status behind the admin tier', () => {
    const card = trackedPage.split(/<div class="card"/).find((c) => c.includes('What the wall last reported'));
    expect(card).toBeDefined();
    expect(card, 'status card is not admin-gated').toContain('data-tier="admin"');
  });

  it('says the default password out loud rather than only in a header', () => {
    expect(trackedPage).toContain('flightwall123');
    expect(trackedPage).toContain('id="defaultWarn"');
  });
});

describe('entry provenance on the page', () => {
  it('marks where an entry came from, since that decides who may remove it', () => {
    // A calendar entry reappears on the next sync if you remove it here and it
    // is still in the feed, and leaves on its own when it drops out. Neither
    // is explicable without the page saying which entries the sync owns.
    expect(trackedPage).toContain("e.source === 'calendar'");
    expect(trackedPage).toContain("e.source === 'manual'");
  });

  it('says nothing at all for an entry stored before source existed', () => {
    // Rendering those as "by hand" would be a plausible-looking lie: nobody
    // knows how they got there. The ternaries above emit '' for null.
    const marker = trackedPage.split("e.source === 'manual'")[1] ?? '';
    expect(marker.slice(0, 60)).toContain("''");
  });
});
