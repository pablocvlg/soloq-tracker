// api/matches.js
// Devuelve detalles de partidas cacheados en memoria del servidor.
// El cliente envía los matchIds que necesita; el servidor solo llama a Riot
// por los que no tiene en caché. Compartido entre TODOS los usuarios.

const https   = require("https");
const ROUTING = "europe.api.riotgames.com";
const DELAY_MS = 1300; // entre llamadas a Riot (~46/min, seguro)

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

// matchCache[matchId] = { [puuid]: { win, champ, k, d, a } }
// Persiste mientras la instancia serverless esté caliente.
// En frío (instancia reciclada) se vuelve a pedir — aceptable, ocurre poco.
const matchCache = {};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "RIOT_API_KEY no configurada" });

  // ids=EUW1_7001,EUW1_7002,...
  const raw = (req.query.ids || "").trim();
  if (!raw) return res.status(400).json({ error: "Falta parámetro ids" });

  const requested = raw.split(",").map(s => s.trim()).filter(Boolean);
  const missing   = requested.filter(id => !matchCache[id]);

  // Descargar solo las que faltan, en serie con delay
  for (const id of missing) {
    try {
      const m = await get(ROUTING, `/lol/match/v5/matches/${id}`, apiKey);
      matchCache[id] = {};
      for (const part of m.info.participants) {
        matchCache[id][part.puuid] = {
          win:   part.win,
          champ: part.championName,
          k:     part.kills,
          d:     part.deaths,
          a:     part.assists,
        };
      }
    } catch (err) {
      console.warn(`[matches] ${id}: ${err.message}`);
      // Marcar como fallido para no reintentar indefinidamente en esta instancia
      matchCache[id] = null;
    }
    await sleep(DELAY_MS);
  }

  // Devolver solo los solicitados (null si fallaron)
  const result = {};
  for (const id of requested) {
    result[id] = matchCache[id] || null;
  }

  return res.status(200).json({
    matches: result,
    cached:  missing.length === 0,
    fetched: missing.length,
  });
};

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
            return reject(new Error(`${res.statusCode}`));
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("JSON parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }