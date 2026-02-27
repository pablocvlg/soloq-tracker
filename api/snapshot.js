// api/snapshot.js
// Hace todas las llamadas a Riot de una vez y cachea el resultado 1 hora en memoria.
// El frontend solo llama a este endpoint — carga instantánea para todos los usuarios.

const ROUTING = "https://europe.api.riotgames.com";
const EUW     = "https://euw1.api.riotgames.com";
const CACHE_TTL = 60 * 60 * 1000; // 1 hora en ms
const DELAY_MS  = 250;             // delay entre llamadas para respetar rate limit

// Lista de jugadores — igual que en el frontend
const PLAYERS = [
  { name: "DDR4 2x16GB 3600", tag: "pepi" },
  { name: "LaDragonaTragona",  tag: "AWA" },
  { name: "lil yowi",  tag: "TS13" },
  { name: "lil aitor",  tag: "EUW" },
  { name: "comehigados",  tag: "EUW" },
  { name: "pepi",  tag: "346" },
  { name: "PapeldeCulo",  tag: "EUW" },
  { name: "FinElGitΔno",  tag: "695" },
  { name: "Xus17zgZ",  tag: "EUW" },
  { name: "Si hombre",  tag: "TMAWA" },
  { name: "Epst3inBunny",  tag: "meow" },
  { name: "her D is bigger",  tag: "cnc" },
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

// Caché en memoria del servidor (persiste mientras la instancia esté caliente)
let cache = null;       // { players: [...], updatedAt: timestamp }
let building = false;   // evita llamadas paralelas si llegan dos peticiones a la vez

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RIOT_API_KEY no configurada" });

  const force = req.query.force === "1"; // ?force=1 para forzar refresh desde el botón

  // Si el caché es válido y no se fuerza refresh, devolver instantáneamente
  if (cache && !force && (Date.now() - cache.updatedAt) < CACHE_TTL) {
    return res.status(200).json({ ...cache, cached: true });
  }

  // Si ya hay una llamada en curso, esperar y devolver lo que haya
  if (building) {
    const start = Date.now();
    while (building && Date.now() - start < 30000) {
      await sleep(300);
    }
    if (cache) return res.status(200).json({ ...cache, cached: true });
    return res.status(503).json({ error: "Snapshot en construcción, reintenta en unos segundos" });
  }

  // Construir el snapshot
  building = true;
  try {
    const players = await buildSnapshot(apiKey);
    cache = { players, updatedAt: Date.now() };
    return res.status(200).json({ ...cache, cached: false });
  } catch(e) {
    console.error("Snapshot error:", e);
    // Si falla pero hay caché viejo, devolverlo igualmente
    if (cache) return res.status(200).json({ ...cache, cached: true, stale: true });
    return res.status(500).json({ error: e.message });
  } finally {
    building = false;
  }
};

async function buildSnapshot(apiKey) {
  const results = [];

  for (const p of PLAYERS) {
    try {
      // 1. Account
      const acc = await riotGet(
        `${ROUTING}/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`,
        apiKey
      );
      await sleep(DELAY_MS);

      // 2. Summoner
      const sum = await riotGet(
        `${EUW}/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`,
        apiKey
      );
      await sleep(DELAY_MS);

      // 3. Rank + Live en paralelo (son independientes)
      const [rankData, liveRaw] = await Promise.all([
        riotGet(`${EUW}/lol/league/v4/entries/by-summoner/${sum.id}`, apiKey),
        riotGetOptional(`${EUW}/lol/spectator/v5/active-games/by-summoner/${acc.puuid}`, apiKey),
      ]);
      await sleep(DELAY_MS);

      results.push({
        gameName: acc.gameName,
        tagLine:  acc.tagLine,
        puuid:    acc.puuid,
        profileIconId:  sum.profileIconId,
        summonerLevel:  sum.summonerLevel,
        rankData,
        inGame: !!(liveRaw && liveRaw.gameId),
      });

    } catch(e) {
      console.warn(`Error fetching ${p.name}#${p.tag}:`, e.message);
      results.push({ gameName: p.name, tagLine: p.tag, error: true });
    }
  }

  return results;
}

async function riotGet(url, apiKey) {
  const r = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!r.ok) throw new Error(`Riot ${r.status} → ${url}`);
  return r.json();
}

// Como live: devuelve null si 404 (no está en partida)
async function riotGetOptional(url, apiKey) {
  const r = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }