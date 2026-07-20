// Host unit tests for ClockFormat.h — compile with g++, no hardware.
#include "../utils/ClockFormat.h"
#include <cstdio>
#include <cstring>
#include <cstdlib>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

static const char *fmt(int h, int m)
{
    static char buf[16];
    formatClock12(h, m, buf, sizeof(buf));
    return buf;
}

int main()
{
    // The two cases everyone gets wrong. Naive `hour % 12` yields "0:00", and a
    // naive `hour < 12 ? AM : PM` is right here but only by luck — both boundaries
    // have to be checked together.
    CHECK(!strcmp(fmt(0, 0), "12:00 AM"));   // midnight is 12 AM, NOT 0 AM
    CHECK(!strcmp(fmt(12, 0), "12:00 PM"));  // noon is 12 PM, NOT 0 PM or 12 AM

    // Either side of each boundary.
    CHECK(!strcmp(fmt(11, 59), "11:59 AM")); // last minute before noon
    CHECK(!strcmp(fmt(13, 0), "1:00 PM"));   // first hour after noon
    CHECK(!strcmp(fmt(23, 59), "11:59 PM")); // last minute of the day
    CHECK(!strcmp(fmt(1, 0), "1:00 AM"));

    // No leading zero on the hour; minutes ALWAYS get one ("3:5 PM" would be wrong).
    CHECK(!strcmp(fmt(15, 45), "3:45 PM"));
    CHECK(!strcmp(fmt(9, 5), "9:05 AM"));
    CHECK(!strcmp(fmt(3, 0), "3:00 AM"));

    // Every hour maps into 1..12 and flips AM/PM exactly once, at noon.
    for (int h = 0; h < 24; ++h)
    {
        const char *s = fmt(h, 30);
        int hh = atoi(s);
        CHECK(hh >= 1 && hh <= 12);
        CHECK(strstr(s, h < 12 ? "AM" : "PM") != nullptr);
    }

    // Fits the buffer the panel uses: the longest output is 8 chars + NUL, so 9 bytes
    // is exactly enough and must not truncate. (Hour 12 is noon -> PM; hour 0 is the
    // AM twin. Both are 8 chars.)
    {
        char tight[9];
        formatClock12(0, 0, tight, sizeof(tight));
        CHECK(!strcmp(tight, "12:00 AM"));
        formatClock12(12, 0, tight, sizeof(tight));
        CHECK(!strcmp(tight, "12:00 PM"));
    }

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
