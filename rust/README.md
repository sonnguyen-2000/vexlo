# Vexlo in Rust

Port of the JavaScript engine (`src/core`) to Rust, done in stages so the Electron app keeps working the whole time.
The interface (`src/renderer`) stays exactly as it is: the final app is a Tauri shell that shows the same HTML.

## Rule for every stage
A Rust function is only "done" when it gives the **same answers as the JavaScript original**.
`tools/gen-fixtures.js` runs the JS code over many inputs and writes `vexlo-core/tests/fixtures/*.tsv`;
`vexlo-core/tests/differential.rs` checks Rust against them (`cargo test`, in `rust/`).
After changing the JS helpers run `node rust/tools/gen-fixtures.js` and commit the new fixtures.

## Stages
| # | What | Source in JS | State |
|---|------|--------------|-------|
| 1a | File names, content-disposition, web-page detection, categories (no dependencies) | `util.js`, `category.js` | done, 1100+ cases checked |
| 1b | HTTP client, proxy (HTTP/SOCKS5), speed limiter, multi-connection download with resume | `http.js`, `limiter.js`, `download.js` | next |
| 2 | HLS / DASH segments, ffmpeg merge, yt-dlp media | `hls.js`, `dash.js`, `segmented.js`, `ytdlp.js` | |
| 3 | Manager, queue, schedule, stats, local API (127.0.0.1:6877), native-messaging host | `manager.js`, `schedule.js`, `stats.js`, `api.js`, `native/host.js` | |
| 4 | Tauri shell: windows, tray, settings, updater, installer; same `src/renderer` | `src/main` | |

The Rust crates and the JS engine are compared with the same test servers (`test/server.js`) from stage 1b on.
