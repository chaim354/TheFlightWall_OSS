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
    expect(trackedPage).toContain('Watched flights');
    expect(trackedPage).toContain('/v1/control');
    expect(trackedPage).toContain('/v1/tracked');
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

  it('says the default password out loud rather than only in a header', () => {
    expect(trackedPage).toContain('flightwall123');
    expect(trackedPage).toContain('id="defaultWarn"');
  });
});
