/**
 * Recovering a carrier code from the two identifiers a card carries.
 *
 * Pure and dependency-free on purpose: tracked/serve.ts and airlineOverrides.ts
 * both need this and the latter reaches for the filesystem, which is no reason
 * for the former to.
 */

/**
 * A carrier code, uppercased: 2-3 alphanumerics with at least one letter.
 *
 * Both vocabularies. The code a person SEES on the wall is the 3-letter ICAO
 * prefix of the callsign ("AIZ"), because that is what the firmware's
 * applyLocalIdentity derives and falls back to -- but the server also has the
 * 2-character marketing IATA code on any flight the schedule matched ("IZ"),
 * and someone reading a boarding pass will reach for that one. Accepting both
 * is cheaper than making the person know which they are holding.
 *
 * "At least one letter" is lifted from tracked/routes.ts's normaliseNumber and
 * rejects the same nonsense for the same reason: a bare "99" is not a carrier.
 */
export function normaliseCarrierCode(raw: string | undefined | null): string | null {
  const s = (raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2,3}$/.test(s)) return null;
  return /[A-Z]/.test(s) ? s : null;
}

/**
 * The operator ICAO a callsign carries: "AIZ994" -> "AIZ", "N172SP" -> null.
 *
 * A DELIBERATE PORT of firmware/utils/CallsignUtils.h's parseAirlineIcao, down
 * to the rule that the fourth character must be a digit -- which is what keeps
 * a tail number from being read as a carrier. The two must agree, because the
 * device derives the code it DISPLAYS with that function: if this parsed
 * "N172SP" as "N17", the page would offer to name a code nobody ever saw, and
 * if it were stricter it would fail to offer one they did.
 */
export function operatorIcaoOf(callsign: string | null | undefined): string | null {
  const s = (callsign ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(s)) return null;
  return s.slice(0, 3);
}

/**
 * The marketing IATA code of a flight number: "IZ994" -> "IZ", "Z0701" -> "Z0".
 *
 * THE FIRST TWO CHARACTERS, not a trailing-digit-run split, and that is a bug
 * fix rather than a preference. An IATA airline designator is always exactly
 * two characters, so there is nothing to infer -- but tracked/serve.ts used to
 * find the prefix by stripping the trailing run of digits, which silently
 * fails for every carrier whose code ENDS in one:
 *
 *   BA181  -> "BA"    both agree
 *   Z0701  -> "Z"     Norse Atlantic, rejected as too short -> no airline name
 *   U2884  -> "U"     easyJet, same
 *
 * Both of those are in the curated table, so their cards were rendering with
 * no airline at all while the name sat right there. The trailing-run split was
 * itself a fix for a real bug -- a greedy `[A-Z0-9]{2,3}` eats the "1" of
 * BA181 -- but a fixed-width slice has no greediness to get wrong.
 *
 * Still validated through normaliseCarrierCode, so "99" and friends are
 * rejected, and the remainder must be all digits or this is not a flight
 * number at all.
 */
export function carrierIataOf(flightNumber: string | null | undefined): string | null {
  const s = (flightNumber ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2}\d{1,4}$/.test(s)) return null;
  return normaliseCarrierCode(s.slice(0, 2));
}
