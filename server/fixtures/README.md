# Fixtures

Recorded provider responses used by the test suite. All of it is public
flight-schedule and ADS-B position data — nothing here needs redaction.

## Status

The AeroDataBox FIDS fixture (`fids-kjfk.json`) is **not yet captured**.
Task 1 Steps 4-6 of the server plan probe AeroDataBox's FIDS endpoint to
settle the credit tier and whether a row carries the operating callsign,
and both require an AeroDataBox API key that is not available in this
environment. That probe is blocked until a key is obtained; see
`docs/superpowers/plans/2026-08-20-flightwall-server-worker.md`, Task 1.
