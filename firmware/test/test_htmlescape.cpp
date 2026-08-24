// Host unit tests for HtmlEscape.h — compile with g++, no hardware.
//
// Guarded like the other loose host tests under test/ so a `pio test` build
// does not collide with them; see the comment in platformio.ini.
//
// WHY THIS EXISTS. The AP setup form renders the current SSID back into an
// HTML value attribute. Network names are attacker-adjacent free text -- any
// neighbouring router can broadcast whatever it likes, and /api/wifiscan puts
// those names in front of this code -- so an unescaped `"` ends the attribute
// and everything after it becomes markup. On the ONE page whose entire job is
// collecting a WiFi password, that is the last place to hand-roll quoting.
#ifndef PIO_UNIT_TESTING
#include "../utils/HtmlEscape.h"
#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

static std::string esc(const char *in) {
    std::string out;
    appendHtmlEscaped(out, in);
    return out;
}

int main() {
    // Nothing to escape: byte-for-byte identical, including spaces.
    CHECK(esc("") == "");
    CHECK(esc("HomeNet") == "HomeNet");
    CHECK(esc("The Smiths 5GHz") == "The Smiths 5GHz");

    // The five metacharacters.
    CHECK(esc("&") == "&amp;");
    CHECK(esc("<") == "&lt;");
    CHECK(esc(">") == "&gt;");
    CHECK(esc("\"") == "&quot;");
    CHECK(esc("'") == "&#39;");

    // Ampersand must be rewritten as part of the SAME pass, not by a second
    // sweep over already-escaped output -- otherwise the `&` this function
    // just emitted gets escaped again and `<` renders as the literal text
    // "&lt;" instead of "<". Feeding it pre-escaped input is what catches it.
    CHECK(esc("&lt;") == "&amp;lt;");
    CHECK(esc("&amp;") == "&amp;amp;");

    // The attribute-escape that motivates the whole file: a quote in an SSID
    // must not be able to close the value and start new markup.
    CHECK(esc("net\" onfocus=\"alert(1)") ==
          "net&quot; onfocus=&quot;alert(1)");
    CHECK(esc("<script>alert(1)</script>") ==
          "&lt;script&gt;alert(1)&lt;/script&gt;");

    // Real-world SSIDs that are legal and contain metacharacters.
    CHECK(esc("Bob & Alice") == "Bob &amp; Alice");
    CHECK(esc("O'Brien") == "O&#39;Brien");

    // Appends rather than overwrites: the caller builds a page incrementally.
    std::string acc = "value=\"";
    appendHtmlEscaped(acc, "a&b");
    acc += "\"";
    CHECK(acc == "value=\"a&amp;b\"");

    // A null pointer is a missing value, not a crash. Settings can hold an
    // unset SSID and the form still has to render.
    std::string n;
    appendHtmlEscaped(n, nullptr);
    CHECK(n == "");

    // High-bit bytes pass through untouched: SSIDs are UTF-8 and mangling
    // them here would corrupt every non-ASCII network name.
    CHECK(esc("Caf\xc3\xa9") == "Caf\xc3\xa9");

    if (failures == 0) { printf("ALL PASS\n"); return 0; }
    printf("%d FAILURES\n", failures);
    return 1;
}
#endif
