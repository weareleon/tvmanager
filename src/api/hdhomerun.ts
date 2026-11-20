import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config";

/**
 * HDHomeRun network tuner emulation, so Plex Live TV & DVR (which doesn't accept M3U
 * playlists) can add tvmanager as a tuner. Plex fetches discover.json from the address
 * you give it, then lineup.json for the channels, and plays each channel's URL as
 * MPEG-TS, which is exactly what /stream/<n>.ts serves. The guide comes from our XMLTV.
 *
 * These endpoints are open (no sign-in), like the playlist and streams: tuners can't log in.
 */

/** A stable device ID, made once and kept in data/, so Plex recognises the tuner across restarts. */
function deviceId(dataDir: string): string {
  const file = join(dataDir, "device.json");
  if (existsSync(file)) {
    try {
      const id = JSON.parse(readFileSync(file, "utf8")).deviceId;
      if (/^[0-9A-F]{8}$/.test(id)) return id;
    } catch {
      /* regenerate below */
    }
  }
  const id = randomBytes(4).toString("hex").toUpperCase();
  writeFileSync(file, JSON.stringify({ deviceId: id }, null, 2));
  return id;
}

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function hdhomerunRoutes(app: FastifyInstance, cfg: Config, baseUrl: (req: FastifyRequest) => string): void {
  const id = deviceId(cfg.dataDir);

  const discover = (req: FastifyRequest) => {
    const base = baseUrl(req);
    return {
      FriendlyName: cfg.server.tunerName,
      Manufacturer: "tvmanager",
      ManufacturerURL: "https://github.com/weareleon/tvmanager",
      ModelNumber: "HDTC-2US",
      FirmwareName: "hdhomeruntc_atsc",
      FirmwareVersion: "20200101",
      DeviceID: id,
      DeviceAuth: "tvmanager",
      TunerCount: cfg.server.tuners,
      BaseURL: base,
      LineupURL: `${base}/lineup.json`,
    };
  };

  const lineup = (req: FastifyRequest) => {
    const base = baseUrl(req);
    return [...cfg.channels]
      .sort((a, b) => a.number - b.number)
      .map((ch) => ({ GuideNumber: String(ch.number), GuideName: ch.name, URL: `${base}/stream/${ch.number}.ts`, HD: 1 }));
  };

  app.get("/discover.json", async (req) => discover(req));
  app.get("/lineup_status.json", async () => ({ ScanInProgress: 0, ScanPossible: 1, Source: "Cable", SourceList: ["Cable"] }));
  app.get("/lineup.json", async (req) => lineup(req));
  // Plex asks the tuner to rescan; there's nothing to scan, so just acknowledge.
  app.post("/lineup.post", async (_req, reply) => reply.code(200).send(""));

  app.get("/lineup.xml", async (req, reply) => {
    const rows = lineup(req)
      .map((c) => `<Program><GuideNumber>${c.GuideNumber}</GuideNumber><GuideName>${xmlEsc(c.GuideName)}</GuideName><URL>${xmlEsc(c.URL)}</URL><HD>1</HD></Program>`)
      .join("");
    reply.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Lineup>${rows}</Lineup>`);
  });

  // UPnP device description, for clients that look for it.
  app.get("/device.xml", async (req, reply) => {
    const d = discover(req);
    reply.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <URLBase>${xmlEsc(d.BaseURL)}</URLBase>
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${xmlEsc(d.FriendlyName)}</friendlyName>
    <manufacturer>${xmlEsc(d.Manufacturer)}</manufacturer>
    <modelName>${d.ModelNumber}</modelName>
    <modelNumber>${d.ModelNumber}</modelNumber>
    <serialNumber>${d.DeviceID}</serialNumber>
    <UDN>uuid:${d.DeviceID.toLowerCase()}-0000-0000-0000-000000000000</UDN>
  </device>
</root>`);
  });
}
