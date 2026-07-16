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
    void put(const K &key, const V &value)
    {
        auto mit = _index.find(key);
        if (mit != _index.end())
        {
            mit->second->second = value;                        // update in place
            _items.splice(_items.begin(), _items, mit->second); // promote to MRU
            return;
        }

        _items.emplace_front(key, value);
        _index[key] = _items.begin();
        trim();
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
