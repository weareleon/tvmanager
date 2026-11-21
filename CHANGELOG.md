# Changelog

## 1.3.0

- **Plex as a media source:** "Sign in with Plex" in the dashboard (Plex's PIN flow, so you never copy a token), then pick a server and libraries.
  - **Imports** movies and TV episodes with season and episode numbers, genres (taken from the show) and chapter markers for mid-roll breaks.
  - **Connection:** tvmanager uses the first of the server's addresses that answers: this PC, then the local network, then remote, then Plex's relay.
  - **Playback:** files are read directly when this PC can reach them, otherwise the original file is streamed from Plex without transcoding. Path replacements and playback mode work as for Jellyfin.
  - **Token safety:** Plex tokens stay on the server. They never reach the browser and are redacted from logs.
- **Plex Live TV verified:** the HDHomeRun tuner from 1.1.0 has now been tested with Plex Media Server 1.43.5. Plex adds it as a 4-tuner device, maps every channel to the XMLTV guide by number, and plays channels in Plex Web.

## 1.2.0

- **Watch in the browser:** a public TV page at `/watch` with a channel grid (now with progress, and next), and a live player at `/watch/<number>`:
  - now/next details, the upcoming guide and a channel list
  - keyboard controls: ↑/↓ change channel, M mutes, F goes fullscreen
  - works on phones too
- No sign-in needed. The page's API only exposes guide data (titles and times), never file paths or settings. Turn it off with `server.publicWatch: false`.
- Playback uses mpegts.js, bundled and served locally, so it works offline. iPhone and iPad get an "Open in VLC" fallback.
- The dashboard links to the browser page from the Channels page and Settings.

## 1.1.0

- **Plex Live TV support:** tvmanager now also acts as an HDHomeRun network tuner (`discover.json`, `lineup.json`, `lineup_status.json`, `device.xml`). In Plex, set up a DVR with tvmanager's address and use its XMLTV guide. The device ID stays stable across restarts, and the tuner count and name are configurable.
- The dashboard shows the Plex tuner address on the Channels page and step-by-step Plex setup on the Settings page.
- Docs: Plex can't use M3U playlists, so the README no longer listed it as a supported player in 1.0.0's text.

## 1.0.0

First public release.

- **Sources:** Jellyfin, Emby and local folders, with collections filtered by library, show, genre, type, folder or path.
- **Scheduling:** weekly blocks and dated special events with priorities, hard block starts with filler and "Up next" slates, and live M3U restream blocks.
- **Playout:** persistent 48-hour timelines per channel, on-demand gapless encoding, and tune-in at the right offset.
- **Commercial breaks:** break styles (clips by count or duration, "Up next" cards over background clips), between programmes and mid-roll at chapter markers.
- **On-screen graphics:** up next and now playing banners, event countdowns, ticker, clock, and animated watermarks, per channel with an accent colour.
- **Dashboard:** channels with a weekly grid, collections with a live preview, break styles, media sources and settings. Changes apply live.
- **Security:** sign-in with users, a first-run setup code, scrypt passwords, CSRF protection, rate limiting and a password reset command.
