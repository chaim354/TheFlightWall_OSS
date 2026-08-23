#pragma once
// Arduino-free, header-only bounded LRU cache.
//
// Fixed-capacity, O(1) get/put with least-recently-used eviction. Replaces the
// old std::map + wholesale clear() pattern: no allocation cliff, no full flush.
//
// Storage: an intrusive-ish std::list holds (key,value) pairs with the
// most-recently-used at the FRONT and the least-recently-used at the BACK. An
// unordered_map maps key -> list iterator for O(1) lookup. On every hit (get or
// overwriting put) the entry is spliced to the front; on overflow the back is
// evicted.
//
// Note: K=Arduino String requires a std::hash<String> specialization, which the
// firmware translation unit provides before instantiating this template (see
// FlightDataFetcher.cpp). std::string keys (host tests) hash out of the box.

#include <list>
#include <unordered_map>
#include <utility>
#include <cstddef>

// Arduino's String has no std::hash specialization, so unordered_map<String,...>
// won't compile without one. When this header is included after Arduino's
// WString.h (which defines String_class_h), String is a complete type and we can
// supply the specialization here — so every translation unit that instantiates
// LruCache<String, ...> sees it before the implicit instantiation. Host tests
// (std::string keys, no Arduino.h) never define String_class_h and skip this.
#ifdef String_class_h
#include <string>
namespace std
{
    template <>
    struct hash<String>
    {
        size_t operator()(const String &s) const
        {
            return std::hash<std::string>()(std::string(s.c_str()));
        }
    };
} // namespace std
#endif

template <class K, class V>
class LruCache
{
public:
    explicit LruCache(size_t capacity) : _capacity(capacity) {}

    // On hit: copy value to out, promote entry to MRU, return true. Else false.
    bool get(const K &key, V &out)
    {
        auto mit = _index.find(key);
        if (mit == _index.end())
            return false;
        _items.splice(_items.begin(), _items, mit->second); // move to front (MRU)
        out = mit->second->second;
        return true;
    }

    // Pointer to the stored value (promoted to MRU), or nullptr if absent.
    // Valid until the next put()/eviction. Avoids copying large values out.
    V *find(const K &key)
    {
        auto mit = _index.find(key);
        if (mit == _index.end())
            return nullptr;
        _items.splice(_items.begin(), _items, mit->second); // move to front (MRU)
        return &mit->second->second;
    }

    // If key exists: update value and promote to MRU. Else insert at MRU and,
    // if over capacity, evict the LRU (back).
    //
    // Returns a pointer to the STORED value, or nullptr if the entry did not
    // survive insertion -- which happens when capacity is 0, since trim() runs
    // before this returns. Same validity rule as find(): good until the next
    // put()/eviction.
    //
    // Two reasons for the pointer rather than void. A caller that wants to
    // build a large value in place (Hub75Display decodes a ~2KB logo tile
    // straight into the cache) had to write put(key, V{}) then find(key) --
    // which briefly stores a DIFFERENT value than intended, and for LogoTile an
    // empty shell is exactly the w==0 "known missing" sentinel. And the find
    // after it was annotated "never null", which is true only while capacity
    // is non-zero; setCapacity(0) is legal and that cache is sized from a
    // runtime setting.
    //
    // Takes `value` BY VALUE so a caller can std::move into it; the copy that
    // used to be forced by const& is now the caller's choice.
    V *put(const K &key, V value)
    {
        auto mit = _index.find(key);
        if (mit != _index.end())
        {
            mit->second->second = std::move(value);             // update in place
            _items.splice(_items.begin(), _items, mit->second); // promote to MRU
            return &mit->second->second;
        }

        _items.emplace_front(key, std::move(value));
        _index[key] = _items.begin();
        trim();

        // trim() may have evicted the entry we just inserted (capacity 0).
        auto after = _index.find(key);
        return after == _index.end() ? nullptr : &after->second->second;
    }

    // Re-bound the cache at runtime. Callers whose working set is configurable
    // (e.g. logo tiles vs. maxFlights) must size capacity to it: cyclic access over
    // a working set larger than capacity evicts exactly the entry needed next, so
    // the hit rate is zero rather than merely reduced. Shrinking evicts LRU-first
    // immediately, so the memory is released when asked for, not on the next put().
    void setCapacity(size_t capacity)
    {
        _capacity = capacity;
        trim();
    }

    size_t capacity() const { return _capacity; }
    size_t size() const { return _index.size(); }

private:
    // Evict LRU-first until the bound holds. Shared by put() (over by at most one)
    // and setCapacity() (may be over by many).
    void trim()
    {
        while (_index.size() > _capacity)
        {
            auto &lru = _items.back(); // least-recently-used
            _index.erase(lru.first);
            _items.pop_back();
        }
    }

    size_t _capacity;
    std::list<std::pair<K, V>> _items; // front = MRU, back = LRU
    std::unordered_map<K, typename std::list<std::pair<K, V>>::iterator> _index;
};
