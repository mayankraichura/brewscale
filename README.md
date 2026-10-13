# BrewScale Weight Log

A single-page web app that logs **weight** and **flow rate (g/s)** from a Bluetooth LE kitchen scale, straight in the
browser. No server, no account, no tracking: everything stays on your device until you download a CSV.

It was made for a DIY scale (ESP32-C3 + HX711 load cell amp) used for pour-over coffee, but any BLE device that sends
the 7-byte packet below will work.

## How it works
1. **Connect** to the scale (Chrome, or Bluefy on iPad).
2. Press **Start brewing**. The page zeroes the weight (switch off with *Zero at start*), clears the charts, sets t0 and starts the timer.
3. The charts show weight and flow rate against brew time. The big red **STOP** button ends the brew (a stop within 1 s of the start is ignored, so a double tap cannot end it).
4. The brew is saved in the browser and appears under *Saved brews*. From there you can **View** it again, download or copy its **CSV**, or delete it.

## Features
- Timer, live weight and flow readouts, and two charts (live last 30 s to 5 min while idle, the whole brew during and after a brew)
- Smoothing: moving average over 1 (off), 3, 5 or 10 samples, with a live noise readout
- "Zero now" button: it only changes what the page shows and logs, the scale is never written to
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
The page only subscribes to notifications and never writes to the device.

## Flow rate
Flow = (mean weight of the last 0.5 s) - (mean weight 1.0 to 1.5 s earlier), in g/s, computed from the smoothed weight
and real arrival times.

## CSV
`time_s,weight_g,flow_gps,raw_g,seq,flags`: `weight_g` is smoothed and after "Zero (view only)", `raw_g` is what the scale
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
