// Host unit tests for LruCache.h — compile with g++, no hardware.
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

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
