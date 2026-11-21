# tvmanager

**Turn your media library into real live TV channels.** Point tvmanager at Plex, Jellyfin, Emby or a folder of videos, build channels in a web dashboard, and watch them in Plex (as an HDHomeRun tuner), Jellyfin, TiVimate, VLC or any IPTV player that reads M3U and XMLTV. It has the things that make it feel like broadcast TV: commercial breaks, "Up next" cards, animated on-screen graphics, countdowns to special events, and schedules down to the day and minute.

Inspired by [ErsatzTV](https://github.com/ErsatzTV/ErsatzTV), with more control over how channels look and when things air. Not affiliated with it.

## Features

**Channels and scheduling**
- **Weekly blocks** ("weekdays 20:00–23:00: movies") and **one-off special events** on a date. Blocks can run past midnight, and priorities decide overlaps.
- **Hard starts:** blocks begin exactly on time. Gaps are filled with filler clips and an "Up next" screen.
- **Always on air:** each channel keeps about 48 hours of schedule even when nobody is watching. Tune in and you join whatever is on, at the right point.
- **Live restreams:** schedule an M3U channel or stream URL as a block, e.g. a live event on New Year's Eve.
- **Gapless playback:** items are spliced into one continuous stream with no black frames between them.

**Commercial breaks**
- **Break styles** built from slots: bumpers, ads by count or "up to 2 minutes", promos, and "Up next" cards, in any order.
- **Between programmes** and/or **mid-roll** every N minutes, snapped to chapter markers when the file has them.
- Breaks never push a scheduled block late. The TV guide shows each programme as one entry.

**On-screen graphics**, drawn live by the encoder, so they cost almost nothing
- **Banners:** "Up next" before a programme ends, and "You're watching" shortly after one starts.
- **Countdown** to the next special event, switching to ON NOW when it starts.
- **Ticker** and **clock**.
- **Watermark** with fade, pulse or slide-in animation (animated GIFs supported), optionally hidden during breaks.
- Each channel has its own **accent colour**, and the dashboard shows a live animated preview.

**Sources**
- **Plex:** "Sign in with Plex" (no tokens to copy), then pick a server and libraries. Titles, episodes, genres and chapters come from Plex.
- **Jellyfin and Emby:** titles, episodes, genres and chapters come from the server. Files are read directly when this PC can reach them, otherwise streamed from the server in original quality.
- **Local folders:** scanned with ffprobe, with `Show - S01E02 - Title` names parsed.
- **Collections:** filter by library, show, genre, type, folder or path text, with a live preview.

**Dashboard**
- Manage everything in the browser. Changes apply live, even to channels being watched.
- **Sign-in** with users, a first-run setup code, rate limiting and CSRF protection. Playlist, guide and stream URLs stay open for TV apps.

## Requirements

- **Node.js 22** or newer
- **ffmpeg and ffprobe**, a full build with `drawtext` (e.g. the [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) "full" build on Windows), on your PATH or set in `config.json`
- Developed and tested on **Windows**. Linux and macOS should work, but point the fonts at files that exist there (see [Configuration](#configuration)).

## Quick start

```bash
git clone https://github.com/weareleon/tvmanager.git
```

```bash
cd tvmanager
```

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:8420**:

1. **Create your account.** On another device, you'll also need the setup code printed in the server log.
2. **Media sources → Add source.** For Jellyfin, create an API key under *Dashboard → API Keys*, paste it in, and use *Test connection* to pick libraries.
3. **Collections → New collection**, e.g. one show, or all movies in the "Comedy" genre.
4. **Channels → New channel.** Pick what it plays, add schedule blocks, breaks, a watermark and graphics.
5. In your TV app, add the **playlist** `http://<this-pc>:8420/iptv/channels.m3u` and the **guide** `http://<this-pc>:8420/iptv/xmltv.xml`. This works in Jellyfin (*Live TV → Tuner devices → M3U Tuner*), TiVimate, VLC, Kodi (IPTV Simple Client) and other M3U players.

### Watching in a browser

Anyone on your network can watch at **`http://<this-pc>:8420/watch`**, with no app and no sign-in:
- **Channel grid:** what's on now (with progress) and next.
- **Player:** live video with a now/next panel, the upcoming guide and a channel list. **↑/↓** changes channel, **M** mutes and **F** goes fullscreen.

Playback uses [mpegts.js](https://github.com/xqq/mpegts.js), served by tvmanager itself, so it works without internet. It works in Chrome, Edge and Firefox on desktop and Android. iPhone and iPad Safari can't play live MPEG-TS in the browser, so the page offers an "Open in VLC" link instead. Browsers start videos muted until you tap to unmute.

To turn it off, set `"server": { "publicWatch": false }` in `config.json`.

### Watching in Plex

Plex Live TV doesn't accept M3U playlists, only network tuners, so tvmanager also acts as an **HDHomeRun tuner**:

1. In Plex, open **Settings → Live TV & DVR → Set up Plex DVR**.
2. If tvmanager isn't listed, choose **Don't see your HDHomeRun device? Enter its network address manually** and enter `http://<this-pc>:8420`.
3. For the guide, choose **Have an XMLTV guide on your server? Click here to use that instead** and enter `http://<this-pc>:8420/iptv/xmltv.xml`.
4. Check the channel matches and finish.

The dashboard's Channels page shows the tuner address to copy. By default the tuner advertises 4 simultaneous streams (`server.tuners`).

The default port is 8420, so tvmanager can run next to ErsatzTV (8409).

## Configuration

Everything you set in the dashboard is saved to `config.json`. You rarely need to edit it by hand; [`config.example.json`](config.example.json) shows the format. Settings only available in the file:

| Setting | Default | |
|---|---|---|
| `server.port` | `8420` | |
| `server.publicUrl` | request host | Base URL written into the playlist, e.g. when behind a reverse proxy |
| `server.idleSeconds` | `20` | Keep a channel's encoder running this long after the last viewer leaves |
| `server.tuners` / `server.tunerName` | `4` / `tvmanager` | What the HDHomeRun tuner tells Plex |
| `server.publicWatch` | `true` | The public browser TV pages at `/watch` |
| `ffmpeg.ffmpeg` / `ffmpeg.ffprobe` | `ffmpeg` / `ffprobe` | Full paths if they're not on PATH |
| `ffmpeg.videoEncoder` | `libx264` | `h264_nvenc` (NVIDIA), `h264_qsv` (Intel), `h264_amf` (AMD) |
| `ffmpeg.width` / `height` / `fps` | `1280` / `720` / `30` | Output format for all channels |
| `ffmpeg.videoBitrate` / `audioBitrate` | `3500k` / `160k` | |
| `ffmpeg.font` / `fontBold` / `fontMono` | Windows Arial / Arial Bold / Consolas Bold | Set these on Linux/macOS, e.g. DejaVu Sans |
| `playoutHours` | `48` | How far ahead schedules are planned |
| `scanIntervalMinutes` | `360` | Automatic library rescans |

Restart after changing these. Everything else applies immediately.

### Plex, Jellyfin and Emby notes

- **Docker or a NAS:** if the server sees files at different paths than this PC (e.g. `/media/...` in Docker), add **path replacements** under *Advanced* (`/media => \\nas\media`), or set playback to *Always stream from the server*.
- **API keys and Plex tokens** are only placed in stream URLs at play time. They never reach the browser, are redacted from logs, and are never written to `data/`.
- **Plex sign-in** uses Plex's PIN flow: you approve tvmanager on plex.tv, and tvmanager connects to the first address of your server that answers (this PC, then your network, then remote, then Plex's relay).

### Locked out

On the tvmanager PC:

```bash
npm run reset-password -- <username>
```

It prints a new password and signs that user out everywhere. Restart tvmanager afterwards.

## Endpoints

| URL | Auth | |
|---|---|---|
| `/` | (sign-in page) | Dashboard |
| `/iptv/channels.m3u` | open | Channel playlist |
| `/iptv/xmltv.xml` | open | TV guide |
| `/stream/<number>.ts` | open | Live MPEG-TS stream |
| `/discover.json`, `/lineup.json`, `/lineup_status.json` | open | HDHomeRun tuner emulation (for Plex) |
| `/watch`, `/watch/<number>` | open | Watch in the browser |
| `/watch-api/...` | open | Read-only guide data for the watch pages (titles and times only) |
| `/api/...` | session | Dashboard API |

Anyone who can reach the server can watch, so don't expose port 8420 to the internet unless you mean to. Only signed-in users can change anything.

## How it works

```
sources → catalog → schedule rules → playout timeline (saved) → channel session → viewers
                                                                  ffmpeg per item, spliced gaplessly
```

- **Timelines:** each channel's timeline is planned ahead from wall-clock time and saved in `data/playouts/`, so the channel "airs" whether or not anyone watches. When someone tunes in, an encoder starts at the right offset. It stops shortly after the last viewer leaves.
- **Encoding:** every item (programme part, ad, card, slate) is encoded by its own ffmpeg process. The next one starts 2 seconds early, and output timestamps come from the schedule, so the joined stream is continuous.
- **Pacing:** the `realtime` filter paces output instead of `-re`, which would replay the run-up from the previous keyframe after a seek and make the channel drift late.
- **Graphics:** drawn with `drawtext`/`drawbox`/`overlay` time expressions computed from wall-clock times. Banners slide in at the right moment even when you tune in mid-programme.

## Roadmap

- **HLS output** and hardware-encoder presets in the dashboard
- More graphic types and templates

## License

[MIT](LICENSE)
