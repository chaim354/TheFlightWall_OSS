/*
Purpose: minimum-viable bring-up image for a NEW board target.

WHY THIS EXISTS. On 2026-08-25 the MatrixPortal S3 flashed cleanly and then
emitted nothing at all -- no boot text, no answer to the serial console -- while
enumerating happily as 303A:1001. Flashing with PSRAM undefined changed nothing;
selecting the USB peripheral explicitly changed nothing. With no output there is
nothing to bisect, so this strips everything the real firmware does until only
two questions remain: is the chip running our code, and can it talk?

It links NONE of the project: no panel, no filesystem, no WiFi, no settings. If
this prints, the fault is in something the full firmware initialises. If it does
not print but the LED blinks, the code runs and SERIAL is the fault. If neither,
the image is not executing at all.

THE LED IS THE POINT. Serial is the thing under suspicion, so a verdict that
depends on serial would be worthless. The onboard NeoPixel is an output path
that shares nothing with USB.
*/
#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include "esp_system.h"
#include "esp_heap_caps.h"

// GPIO 4 on the MatrixPortal S3, per CircuitPython's board definition.
static Adafruit_NeoPixel pixel(1, 4, NEO_GRB + NEO_KHZ800);

static const char *resetReasonName(esp_reset_reason_t r)
{
    switch (r)
    {
    case ESP_RST_POWERON:  return "power-on";
    case ESP_RST_EXT:      return "external pin";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "PANIC (crash)";
    case ESP_RST_INT_WDT:  return "interrupt watchdog";
    case ESP_RST_TASK_WDT: return "task watchdog";
    case ESP_RST_WDT:      return "other watchdog";
    case ESP_RST_DEEPSLEEP:return "deep sleep wake";
    case ESP_RST_BROWNOUT: return "BROWNOUT (supply sagged)";
    case ESP_RST_SDIO:     return "sdio";
    default:               return "unknown";
    }
}

void setup()
{
    // LED first, before anything that could hang. It is the only signal that
    // survives a broken serial path.
    pixel.begin();
    pixel.setBrightness(40);
    pixel.setPixelColor(0, pixel.Color(0, 0, 60)); // blue: alive, pre-Serial
    pixel.show();

    Serial.begin(115200);
    // Native USB needs the HOST to open the port before anything is delivered;
    // 200ms is not enough and the real firmware's early prints are lost to this.
    // Bounded so a board with nobody listening still proceeds to blink.
    const unsigned long start = millis();
    while (!Serial && millis() - start < 5000)
        delay(50);

    Serial.println();
    Serial.println("=== FlightWall bring-up image ===");
    Serial.printf("reset reason : %s\n", resetReasonName(esp_reset_reason()));
    Serial.printf("chip         : %s rev%d, %d core(s) @ %luMHz\n",
                  ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(),
                  (unsigned long)ESP.getCpuFreqMHz());
    Serial.printf("flash        : %lu bytes\n", (unsigned long)ESP.getFlashChipSize());
    Serial.printf("PSRAM        : %lu bytes (0 = absent or not initialised)\n",
                  (unsigned long)ESP.getPsramSize());
    Serial.printf("free heap    : %lu bytes\n", (unsigned long)ESP.getFreeHeap());
    Serial.println("blinking green: if you see this LED, the image is RUNNING");
    Serial.println("type anything; it will be echoed back");
}

void loop()
{
    static bool on = false;
    static unsigned long last = 0;
    if (millis() - last >= 500)
    {
        last = millis();
        on = !on;
        pixel.setPixelColor(0, on ? pixel.Color(0, 60, 0) : 0);
        pixel.show();
        Serial.printf("[alive] uptime %lus  heap %lu\n",
                      (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap());
    }
    while (Serial.available())
        Serial.write(Serial.read()); // echo proves the RX path too
}
