#pragma once

#include <algorithm>
#include <vector>

// Move pinned entries to the front, preserving relative order within both
// groups.
//
// std::stable_partition, not sort: the caller has ALREADY ordered these
// nearest-first, and pinning is meant to change which group a card is in, not
// to reorder within a group. A plain sort would silently discard that ordering
// and the cards would shuffle every cycle.
template <typename T, typename IsPinned>
inline void stablePinFirst(std::vector<T> &v, IsPinned isPinned)
{
    std::stable_partition(v.begin(), v.end(), isPinned);
}
