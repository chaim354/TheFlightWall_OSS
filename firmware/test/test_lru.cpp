// Host unit tests for LruCache.h — compile with g++, no hardware.
//
// Guarded so a `pio test` build doesn't collide with the other loose host
// tests under test/ -- see the test_filter comment in platformio.ini. This
// file is a standalone host test; it only runs via bare g++, which never
// defines PIO_UNIT_TESTING, so the guard is a no-op for that workflow and
// this file's behavior there is unchanged.
#ifndef PIO_UNIT_TESTING
#include "../utils/LruCache.h"
#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

int main() {
    // construct with capacity N; size()==0
    {
        LruCache<std::string, int> c(4);
        CHECK(c.size() == 0);
    }

    // put then get returns the value (out-param + bool found)
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1);
        int v = -1;
        CHECK(c.get("A", v) == true);
        CHECK(v == 1);
        CHECK(c.size() == 1);
    }

    // get on a missing key returns false
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1);
        int v = -1;
        CHECK(c.get("Z", v) == false);
    }

    // put beyond capacity evicts the LEAST-recently-used; get counts as a use.
    // capacity 2; put A,B; get A (A now MRU); put C -> B evicted; A and C present.
    {
        LruCache<std::string, int> c(2);
        c.put("A", 1);
        c.put("B", 2);
        int v = -1;
        CHECK(c.get("A", v) == true && v == 1); // bump A to MRU
        c.put("C", 3);                          // B is LRU -> evicted
        CHECK(c.get("B", v) == false);          // B gone
        CHECK(c.get("A", v) == true && v == 1); // A present
        CHECK(c.get("C", v) == true && v == 3); // C present
        CHECK(c.size() == 2);
    }

    // overwriting an existing key updates value in place, does NOT grow size,
    // and counts as a use.
    {
        LruCache<std::string, int> c(2);
        c.put("A", 1);
        c.put("B", 2);
        c.put("A", 10);                          // overwrite + bump A to MRU
        int v = -1;
        CHECK(c.get("A", v) == true && v == 10); // updated value
        CHECK(c.size() == 2);                    // did not grow
        // A is MRU (overwrite counted as a use), so inserting C evicts B.
        c.put("C", 3);
        CHECK(c.get("B", v) == false);           // B evicted
        CHECK(c.get("A", v) == true && v == 10);
        CHECK(c.get("C", v) == true && v == 3);
    }

    // find() on a missing key returns nullptr
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1);
        CHECK(c.find("Z") == nullptr);
    }

    // find() returns a pointer to the stored value
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1);
        int *p = c.find("A");
        CHECK(p != nullptr);
        CHECK(p != nullptr && *p == 1);
    }

    // mutating through the pointer find() returns is visible on a later lookup
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1);
        int *p = c.find("A");
        CHECK(p != nullptr);
        if (p) *p = 42;
        int *q = c.find("A");
        CHECK(q != nullptr && *q == 42);
        int v = -1;
        CHECK(c.get("A", v) == true && v == 42); // get() agrees
        CHECK(c.size() == 1);                    // find() does not insert
    }

    // find() counts as a use (promotes to MRU).
    // capacity 2; put A,B; find A (A now MRU); put C -> B evicted; A survives.
    {
        LruCache<std::string, int> c(2);
        c.put("A", 1);
        c.put("B", 2);
        CHECK(c.find("A") != nullptr);  // bump A to MRU
        c.put("C", 3);                  // B is LRU -> evicted
        CHECK(c.find("B") == nullptr);  // B gone
        int *a = c.find("A");
        CHECK(a != nullptr && *a == 1); // A present
        int *cc = c.find("C");
        CHECK(cc != nullptr && *cc == 3);
        CHECK(c.size() == 2);
    }

    // size() never exceeds capacity
    {
        LruCache<std::string, int> c(3);
        for (int i = 0; i < 100; ++i) {
            c.put(std::to_string(i), i);
            CHECK(c.size() <= 3);
        }
        CHECK(c.size() == 3);
    }

    // setCapacity() grows the bound: entries survive that the old bound would evict.
    {
        LruCache<std::string, int> c(2);
        c.put("A", 1);
        c.put("B", 2);
        c.setCapacity(4);
        c.put("C", 3);
        c.put("D", 4);
        int v = -1;
        CHECK(c.get("A", v) == true && v == 1);
        CHECK(c.get("B", v) == true && v == 2);
        CHECK(c.get("C", v) == true && v == 3);
        CHECK(c.get("D", v) == true && v == 4);
        CHECK(c.size() == 4);
    }

    // setCapacity() shrinking evicts LRU-first and does so IMMEDIATELY — not lazily
    // on the next put(). A shrink that deferred eviction would hold memory the
    // caller just asked us to give back.
    {
        LruCache<std::string, int> c(4);
        c.put("A", 1); // LRU
        c.put("B", 2);
        c.put("C", 3);
        c.put("D", 4); // MRU
        c.setCapacity(2);
        CHECK(c.size() == 2);
        int v = -1;
        CHECK(c.get("A", v) == false); // evicted (oldest)
        CHECK(c.get("B", v) == false); // evicted
        CHECK(c.get("C", v) == true && v == 3);
        CHECK(c.get("D", v) == true && v == 4);
    }

    // setCapacity() to the current value is a no-op
    {
        LruCache<std::string, int> c(2);
        c.put("A", 1);
        c.put("B", 2);
        c.setCapacity(2);
        int v = -1;
        CHECK(c.size() == 2);
        CHECK(c.get("A", v) == true);
        CHECK(c.get("B", v) == true);
    }

    // the bound set by setCapacity() holds on subsequent puts
    {
        LruCache<std::string, int> c(4);
        for (int i = 0; i < 4; ++i) c.put(std::to_string(i), i);
        c.setCapacity(2);
        for (int i = 10; i < 20; ++i) { c.put(std::to_string(i), i); CHECK(c.size() <= 2); }
        CHECK(c.size() == 2);
    }

    // REGRESSION (logo tiles, 4-slot cache vs 8 cycled flights): round-robin access
    // over a working set LARGER than capacity is the LRU worst case — it evicts
    // precisely the entry needed next, so the hit rate is exactly zero, not merely
    // degraded. Sizing capacity to the working set is what fixes it.
    {
        auto cycleHits = [](size_t capacity, int workingSet, int passes) {
            LruCache<std::string, int> c(capacity);
            for (int i = 0; i < workingSet; ++i) c.put(std::to_string(i), i);
            int hits = 0, v = -1;
            for (int p = 0; p < passes; ++p)
                for (int i = 0; i < workingSet; ++i) {
                    if (c.get(std::to_string(i), v)) hits++;
                    else c.put(std::to_string(i), i); // miss -> repopulate, as the display does
                }
            return hits;
        };
        CHECK(cycleHits(4, 8, 3) == 0);  // undersized: every single access misses
        CHECK(cycleHits(8, 8, 3) == 24); // sized to the working set: every access hits
    }

    // put() hands back the slot it stored into.
    //
    // Hub75Display wanted to build a ~2KB tile inside the cache rather than
    // construct it outside and copy it in, and with a void put() taking const&
    // the only way was put(key, V{}) followed by find(key). That inserts a
    // TRANSIENT value first -- for LogoTile, an empty shell is exactly the
    // w==0 "known missing" negative-cache sentinel -- and then asserts the
    // find cannot fail. It can: see the zero-capacity case below.
    {
        LruCache<std::string, std::vector<int>> c(2);
        std::vector<int> *slot = c.put("a", std::vector<int>{1, 2, 3});
        CHECK(slot != nullptr);
        CHECK(slot->size() == 3);
        slot->push_back(4);                       // build in place
        CHECK(c.find("a") != nullptr);
        CHECK(c.find("a")->size() == 4);          // wrote through to the stored value
    }

    // Updating an existing key returns the slot too, and it is the same one.
    {
        LruCache<std::string, int> c(2);
        int *first = c.put("a", 1);
        int *again = c.put("a", 2);
        CHECK(first == again);                    // updated in place, not re-inserted
        CHECK(*again == 2);
        CHECK(c.size() == 1);
    }

    // A zero-capacity cache stores nothing, and put() SAYS so instead of
    // leaving the caller to dereference a slot that was evicted on the way in.
    // Reachable: setCapacity(0) is legal and Hub75Display sizes its logo cache
    // from a runtime setting.
    {
        LruCache<std::string, int> c(0);
        CHECK(c.put("a", 1) == nullptr);
        CHECK(c.size() == 0);
        LruCache<std::string, int> d(2);
        d.put("a", 1);
        d.setCapacity(0);
        CHECK(d.size() == 0);
        CHECK(d.put("b", 2) == nullptr);
    }

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif // PIO_UNIT_TESTING
