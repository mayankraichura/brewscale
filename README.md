# BrewScale Weight Log

A single-page web app that logs **weight** and **flow rate (g/s)** from a Bluetooth LE kitchen scale, straight in the
browser. No server, no account, no tracking: everything stays on your device until you download a CSV.

It was made for a DIY scale (ESP32-C3 + HX711 load cell amp) used for pour-over coffee, but any BLE device that sends
the 7-byte packet below will work.

## Layout
The look comes from a design (`weightlog/design` in the project folder, not published).
- **Tablet landscape / desktop (900 px wide or more):** a dashboard that fits one screen without scrolling. Top bar: Settings, title, connection and rate, Saved brews, Connect. Left: weight (with the Zero button) and flow, then the timer with the very large Start brewing / STOP tile. Right: one tall card with the weight and flow charts; in Compare the two charts sit side by side with the table under them.
- **Settings** slide in from the left and **Saved brews** from the right. Messages and the CSV text box are pop-ups; lasting problems (no Bluetooth, connection lost during a brew) use a banner.
- **Portrait tablet (560 to 899 px):** one column with wide cards. **Phone (below 560 px):** one column, smaller type.
- Dark theme by default, light theme through the system setting. Each chart series differs in colour and in line style, so colour is never the only cue. The red dot next to "Brewing" is the recording indicator; the connection dot is green.

## How it works
1. **Connect** to the scale (Chrome, or Bluefy on iPad).
2. Press **Start brewing**. The page zeroes the weight on this page (switch off with *Zero at start* in Settings), clears the charts, sets t0 and starts the timer. The **Tare** button sends the scale's own tare command and clears the graphs (see *Tare* below).
3. The charts show weight and flow rate against brew time. The big red **STOP** button ends the brew (a stop within 1 s of the start is ignored, so a double tap cannot end it).
4. **Espresso / no 3-way valve:** if you lift the cup before the draw is over, the brew ends by itself (option *End brew when the cup is removed*). It triggers when the raw weight falls by 20 g or more (adjustable) within 2 s. The brew is marked complete where the last stable reading ended, the rows after it are dropped, and the weight at that moment is the yield. Small touches of the cup do not trigger it. Put the cup back later: it does not matter, the brew is finished.
5. **Open CSV…** (or drop a file on the page) shows a CSV that this page exported, as a finished brew, even on another device. It is not saved unless you press *Save in browser*. Files that still contain the cup lift are cut at the cup removal, with the same rule as above.
6. **Compare:** tick 2 to 4 saved brews in the list and press *Compare*. Weight and flow of all of them are drawn on the same charts (different colours and line styles), with a table of first drip, completion time, yield, average flow and peak flow. *Time zero at* switches between the brew start and the first drip (useful to line up espresso shots). Flow is shown as recorded, so brews with different smoothing look smoother or rougher.
7. The brew is saved in the browser and appears under *Saved brews*. From there you can **View** it again, download or copy its **CSV**, or delete it.

## Features
- Finished brews show a summary: completion time, yield, first drip and average flow
- Timer, live weight and flow readouts, and two charts (live last 30 s to 5 min while idle, the whole brew during and after a brew)
- Smoothing: moving average over 1 (off), 3, 5 or 10 samples, with a live noise readout
- **Tare** button: tares the scale over Bluetooth (the only command the page ever sends) and clears the graphs
- Compare 2 to 4 saved brews on one chart, with a metrics table
- Open a downloaded CSV again (button or drag and drop) and view it; optionally save it in the browser
- Saved brews survive reloads and closed tabs (last 20, in the browser's local storage)
- If the page is reloaded or crashes during a brew, the part that was recorded is kept as an *interrupted* brew
- Optional label (used in the file name), CSV download or copy
- Reconnects by itself if the Bluetooth link drops (the timer keeps running)
- `?demo` in the URL shows simulated data (no scale needed)

## Browser support
Web Bluetooth is needed, on an `https://` page (or `http://localhost`):

| Platform | Works? |
|---|---|
| Chrome / Edge on Windows, macOS, Linux, ChromeOS | yes |
| Chrome on Android (phone or tablet) | yes |
| Safari or Chrome on iPhone / iPad | no: iOS browsers use WebKit, which has no Web Bluetooth. The third-party **Bluefy** browser can open this page |
| Firefox | no |

The scale accepts one connection at a time, so disconnect other devices from it first.

## The Bluetooth interface this page expects
Device name `BrewScale`; service `b5a10001-5e1d-4c2a-9a3b-2f3c8d6e0001`; characteristic
`b5a10002-5e1d-4c2a-9a3b-2f3c8d6e0001` (read + notify), 7 bytes, little endian:

| Bytes | Type | Meaning |
|---|---|---|
| 0-3 | int32 | weight in 0.01 g |
| 4-5 | uint16 | sequence number (wraps), used to count lost packets |
| 6 | uint8 | flags: bit0 tared, bit1 calibrated, bit2 no data from the load cell amp |

To use another device, change the two UUID constants at the end of `core.js` and the `name` filter in `index.html`.
The page subscribes to the weight notifications. It also uses the command characteristic
`b5a10003-5e1d-4c2a-9a3b-2f3c8d6e0001` (write, replies by notify) for ONE thing: after a tap on **Tare** it writes the
text `t` and reads the replies (`taring: ...`, `tared`, `busy`). It never writes anything else (no calibration, no OTA).

## Battery
If the scale offers the standard Battery Service (`0x180F`, characteristic `0x2A19`, one byte, percent), the page shows
`bat ≈NN %` next to the connection status (in the second row on a phone), in red below 15 %.
- The percent is an **estimate**: it is derived from the cell voltage of the scale's batteries, and the voltage sags under load.
- The service is optional: the page asks for it as an optional service, reads the level once after connecting and then only
  receives changes. It never polls and never writes to this service.
- A scale without the service (older firmware, USB power) simply shows nothing.

## Tare
- The platform must be empty and still for 2 s. The button shows "Taring..." and then "Tared"; the graphs are cleared and the weight starts at 0.
- Locked while a brew is recording (a tare would zero the log). One command per tap, no automatic retry.
- If the scale answers "busy", or does not answer within 6 s, a message says so and nothing is zeroed.
- The tare is stored on the scale, so other devices that use the same scale see it too.
- If the scale has no command characteristic (older firmware) the button is called **Zero** and works on this page only.
- Start brewing still zeroes only on this page (instant, switch off with *Zero at start*), because a scale tare takes 2 s.

## Flow rate
Flow = (mean weight of the last 0.5 s) - (mean weight 1.0 to 1.5 s earlier), in g/s, computed from the smoothed weight
and real arrival times.

## CSV
`time_s,weight_g,flow_gps,raw_g,seq,flags`: `weight_g` is smoothed and after the tare or zero, `raw_g` is what the scale
sent. `time_s` is the brew time (0 = Start brewing). The first 1.5 s of a brew have no flow value. The file name contains the label, the smoothing and the start time.

## Run it
- **Live page: https://mayankraichura.github.io/brewscale/** (open it in a supported browser; add `?demo` to try it without a scale)
- Locally: `python3 -m http.server 8101` in this folder, then open http://localhost:8101
- Tests (no dependencies): `node test.js`

## Saving the CSV
- Desktop: **Download CSV** saves a file.
- iPad / iPhone (Bluefy): **Download CSV** opens the share sheet, choose *Save to Files*. If that is not offered, **Copy CSV** puts the text on the clipboard (paste it into Notes or Files), and a text box appears as a last resort.

## Storage
The running brew is saved in the browser every 3 s and when the page is hidden. Finished brews are kept under `wl.b.<id>` in local storage, with an index; the oldest are dropped when the 20-brew limit or the browser's storage limit is reached. Nothing leaves your device. Clear them with *Delete* / *Delete all*, or by clearing the site's data.

## Privacy
The page makes no network requests except loading its own files. It stores your settings and your saved brews in the browser's local storage, on your device only. Nothing is sent anywhere.

## License
MIT, see `LICENSE`.
