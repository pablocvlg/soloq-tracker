// api/snapshot.js  ─  caché de 1 hora en memoria del servidor
// Reutiliza exactamente la misma lógica de fetch que riot.js (que ya funciona)

const https     = require("https");
const ROUTING   = "europe.api.riotgames.com";
const EUW       = "euw1.api.riotgames.com";
const CACHE_TTL = 60 * 60 * 1000; // 1 hora
const DELAY_MS  = 350;             // ms entre jugadores (rate limit safe)

const PLAYERS = [
  { name: "DDR4 2x16GB 3600", tag: "pepi" },
  { name: "LaDragonaTragona",  tag: "AWA"   },
  { name: "lil yowi",          tag: "TS13"  },
  { name: "lil aitor",         tag: "EUW"   },
  { name: "comehigados",       tag: "EUW"   },
  { name: "pepi",              tag: "346"   },
  { name: "PapeldeCulo",       tag: "EUW"   },
  { name: "FinElGitΔno",       tag: "695"   },
  { name: "Xus17zgZ",          tag: "EUW"   },
  { name: "Si hombre",         tag: "TMAWA" },
  { name: "Epst3inBunny",      tag: "meow"  },
  { name: "her D is bigger",   tag: "cnc"   },
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

let cache    = null;   // { players, updatedAt }
let building = false;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RIOT_API_KEY no configurada" });

  const force = req.query.force === "1";

  // Devolver caché si es fresco
  if (cache && !force && Date.now() - cache.updatedAt < CACHE_TTL) {
    return res.status(200).json({ ...cache, cached: true });
  }

  // Si ya está construyendo, esperar
  if (building) {
    const t0 = Date.now();
    while (building && Date.now() - t0 < 55000) await sleep(400);
    if (cache) return res.status(200).json({ ...cache, cached: true });
    return res.status(503).json({ error: "Construyendo snapshot, reintenta" });
  }

  building = true;
  try {
    const players = await buildSnapshot(apiKey);
    cache = { players, updatedAt: Date.now() };
    return res.status(200).json({ ...cache, cached: false });
  } catch (e) {
    console.error("Snapshot fatal:", e.message);
    if (cache) return res.status(200).json({ ...cache, cached: true, stale: true });
    return res.status(500).json({ error: e.message });
  } finally {
    building = false;
  }
};

// ─────────────────────────────────────────────────────────────
async function buildSnapshot(apiKey) {
  const results = [];

  for (const p of PLAYERS) {
    try {
      // 1. Account → puuid, gameName, tagLine
      const acc = await get(ROUTING,
        `/riot/account/v1/accounts/by-riot-id/${e(p.name)}/${e(p.tag)}`,
        apiKey);
      await sleep(DELAY_MS);

      // 2. Summoner → profileIconId, summonerLevel
      const sum = await get(EUW,
        `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`,
        apiKey);
      await sleep(DELAY_MS);

      // 3. Rank → rankData array  (by-puuid, igual que riot.js)
      const rankData = await get(EUW,
        `/lol/league/v4/entries/by-puuid/${acc.puuid}`,
        apiKey);
      await sleep(DELAY_MS);

      // 4. Live game → null si no está jugando
      const live = await getOpt(EUW,
        `/lol/spectator/v5/active-games/by-summoner/${acc.puuid}`,
        apiKey);
      await sleep(DELAY_MS);

      results.push({
        gameName:      acc.gameName,
        tagLine:       acc.tagLine,
        puuid:         acc.puuid,
        profileIconId: sum.profileIconId,
        summonerLevel: sum.summonerLevel,
        rankData,                           // array con entradas soloQ / flex
        inGame:        !!(live && live.gameId),
      });

    } catch (err) {
      console.warn(`[snapshot] ${p.name}#${p.tag}: ${err.message}`);
      results.push({ gameName: p.name, tagLine: p.tag, error: true });
    }
  }

  return results;
}

// ─── HTTPS helpers ────────────────────────────────────────────
function get(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET",
        headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`${res.statusCode} ${hostname}${path}`));
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("JSON parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function getOpt(hostname, path, apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: "GET",
        headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode === 404 || res.statusCode >= 400) return resolve(null);
          try { resolve(JSON.parse(raw)); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function e(s) { return encodeURIComponent(decodeURIComponent(s)); }