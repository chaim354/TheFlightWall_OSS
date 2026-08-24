#pragma once

// Escape text for interpolation into HTML, including into a quoted attribute.
//
// The AP setup form renders the currently-stored SSID back into a value
// attribute so the user can see and correct it. That string is not ours: any
// neighbouring access point picks its own name, and /api/wifiscan hands those
// names straight to this code. A `"` in one of them would close the attribute
// and turn the remainder into markup -- on the single page whose entire purpose
// is collecting a WiFi password, which makes it the worst page in the firmware
// to hand-roll quoting on.
//
// Templated on the output type rather than returning one, for two reasons: it
// has to serve both Arduino `String` on the device and `std::string` under the
// host tests, and the caller is building a page incrementally, so appending
// avoids a temporary per interpolation on a device where the largest free block
// is the scarce resource (see PIXEL_COLOR_DEPTH_BITS in platformio.ini).
//
// Single pass, deliberately. The obvious implementation -- replace `&` first,
// then `<`, then `>` -- re-escapes the ampersands it just emitted, so `<` comes
// out as the literal text "&lt;" instead of "<". Rewriting each input byte
// exactly once makes that unrepresentable rather than merely avoided; the test
// pins it by feeding in already-escaped input.
//
// A null pointer is treated as an absent value and appends nothing: Settings
// can hold an unset SSID and the form still has to render.
template <typename Str>
inline void appendHtmlEscaped(Str &out, const char *in)
{
    if (in == nullptr)
        return;

    for (const char *p = in; *p != '\0'; ++p)
    {
        switch (*p)
        {
        case '&':
            out += "&amp;";
            break;
        case '<':
            out += "&lt;";
            break;
        case '>':
            out += "&gt;";
            break;
        case '"':
            out += "&quot;";
            break;
        case '\'':
            // &#39; not &apos;: the named form is not in the HTML 4 entity set
            // and is unreliable in the restricted WebView a captive portal
            // opens, which is exactly where this page gets used.
            out += "&#39;";
            break;
        default:
            // Bytes above 0x7F fall here untouched, so UTF-8 SSIDs survive.
            out += *p;
            break;
        }
    }
}
