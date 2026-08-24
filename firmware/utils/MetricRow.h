#pragma once

// Fill one fixed-width display row from candidates in PRIORITY ORDER.
//
// Replaces the mutually-exclusive if/else-if chain displayMiniCard's second
// metric row used to use, where ETA, the flight number and vertical rate each
// claimed the same single slot so only one could ever be shown. That was a
// deliberate width compromise -- Trk plus a long callsign plus an ETA really
// does overflow 21 columns -- but its cost was that a card showing "lands in
// 7h10" could never also say WHICH flight lands then, which is the pair a
// viewer most wants together.
//
// The rule: walk the candidates in order and take each one that still fits,
// separated by single spaces. Order IS priority, so the caller expresses what
// matters most by listing it first.
//
// A candidate that does not fit is SKIPPED, not truncated, and skipping it does
// not stop a shorter later candidate being taken -- so a long "Trk:230deg"
// giving way to a short "Vr:0" is normal, not a bug. Truncating instead would
// put an ellipsis in the middle of a number, and a half-shown heading is worse
// than no heading: it reads as a real value.
//
// Nothing here truncates. The caller's truncateToColumns() remains the
// last-resort clamp for a single pathological value arriving from the wire.
template <typename Seq>
inline auto joinWithinColumns(const Seq &items, int maxCols) -> typename Seq::value_type
{
    typename Seq::value_type row;
    if (maxCols <= 0)
        return row;

    for (const auto &item : items)
    {
        if (item.length() == 0)
            continue; // an absent value must not leave a stray separator

        const int need = (int)item.length() + (row.length() ? 1 : 0);
        if ((int)row.length() + need > maxCols)
            continue; // does not fit -- try the next, shorter, candidate

        if (row.length())
            row += " ";
        row += item;
    }
    return row;
}
