#pragma once
// Arduino-free pure helpers (host-testable). Templated on the string type so the
// panel passes Arduino String and test_trackedviews.cpp passes std::string --
// the same trick MetricRow.h uses. No Arduino.h, no GFX.
#include <cstdio>

// A tracked card holds the wall for kTrackedDwellMs and splits it between up to
// three views, shown in this order:
//
//   Normal -- the ordinary card, with miles flown where the flight number goes
//   Times  -- "Departed 2h10 ago" / "Arriving in ~1h05"
//   Place  -- "Flying over" / "Springfield, IL"
//
// A view with nothing to say is left out rather than shown empty, and the dwell
// is shared between the ones that remain: a card from a server too old to send
// the place gets two 7.5s views, not two 5s views and a blank one.
enum class TrackedView : unsigned char
{
    Normal,
    Times,
    Place,
};

static const int kMaxTrackedViews = 3;

// Fifteen seconds, against the three-second default an area card gets: a
// tracked flight is the one card somebody asked to see, and three views at five
// seconds each is about as fast as a line of text can be read from across a room.
static const unsigned long kTrackedDwellMs = 15000UL;

// Which of `viewCount` views is up `elapsedMs` after the card came up.
//
// MODULO, not clamped at the last view, because a tracked flight can be the
// ONLY card -- the cycle never advances then, the card is never replaced, and
// the views have to keep turning over on their own.
inline int trackedViewAt(unsigned long elapsedMs, int viewCount, unsigned long dwellMs = kTrackedDwellMs)
{
    if (viewCount <= 1)
        return 0;
    const unsigned long slot = dwellMs / (unsigned long)viewCount;
    if (slot == 0)
        return 0;
    return (int)((elapsedMs / slot) % (unsigned long)viewCount);
}

// The first candidate that fits in `maxCols`, else the LAST (shortest) one, for
// the caller's truncateToColumns to clamp. Ordered longest-and-clearest first.
template <typename Str>
inline Str firstThatFits(const Str *cands, int count, int maxCols)
{
    for (int i = 0; i < count; ++i)
        if ((int)cands[i].length() <= maxCols)
            return cands[i];
    return count > 0 ? cands[count - 1] : Str();
}

// "Departed 2h10 ago", shortening for narrow panels. Empty without a time.
template <typename Str>
inline Str departedLine(const Str &depText, int maxCols)
{
    if (depText.length() == 0)
        return Str();
    const Str c[] = {
        Str("Departed ") + depText + Str(" ago"),
        Str("Dep ") + depText + Str(" ago"),
        Str("Dep ") + depText,
    };
    return firstThatFits(c, 3, maxCols);
}

// "Arriving in ~1h05", or "Landing now" for the server's LANDING -- which is a
// state, not a duration, and "Arriving in LANDING" is not a sentence. Empty
// without an ETA.
template <typename Str>
inline Str arrivingLine(const Str &etaText, int maxCols)
{
    if (etaText.length() == 0)
        return Str();
    if (etaText == Str("LANDING"))
    {
        const Str c[] = {Str("Landing now"), Str("Landing")};
        return firstThatFits(c, 2, maxCols);
    }
    const Str c[] = {
        Str("Arriving in ") + etaText,
        Str("Arr in ") + etaText,
        Str("Arr ") + etaText,
    };
    return firstThatFits(c, 3, maxCols);
}

// The label over the place name. "Near" when the server says the town is not
// under the aircraft -- see over_near in src/tracked/serve.ts.
template <typename Str>
inline Str placeLabel(bool near, int maxCols)
{
    const Str c[] = {Str(near ? "Flying near" : "Flying over"), Str(near ? "Near" : "Over")};
    return firstThatFits(c, 2, maxCols);
}

// "Springfield, IL", or just "Springfield" when the region will not fit. The
// name is the part worth keeping; a region cut to "Springfield, Ar..." is noise.
template <typename Str>
inline Str placeLine(const Str &name, const Str &region, int maxCols)
{
    if (name.length() == 0)
        return Str();
    if (region.length() == 0)
        return name;
    const Str c[] = {name + Str(", ") + region, name};
    return firstThatFits(c, 2, maxCols);
}

// "989mi flown" or the bare "989mi". Not "1,234": the comma costs a column the
// row may not have, and four digits read fine without it.
template <typename Str>
inline Str flownText(double mi, bool withWord)
{
    char buf[24];
    snprintf(buf, sizeof(buf), withWord ? "%ldmi flown" : "%ldmi", (long)(mi + 0.5));
    return Str(buf);
}
