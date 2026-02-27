// api/riot.js — Vercel Serverless Function
// Añade tu API key en Vercel → Project Settings → Environment Variables
// Variable name: RIOT_API_KEY -> secret

const ROUTING = "https://europe.api.riotgames.com";
const EUW     = "https://euw1.api.riotgames.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

module.exports = async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS_HEADERS).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "RIOT_API_KEY no configurada en Vercel" });
  }

  // El path llega como query param: /api/riot?path=/account/Faker/EUW
  const path = req.query.path || "";
  const qs   = req.query.qs   || "";   // query string adicional (ej: count=5)

  try {
    // ── /account/:gameName/:tagLine ──────────────────────────────
    if (path.startsWith("/account/")) {
      const [, , gameName, tagLine] = path.split("/");
      return proxy(res, apiKey,
        `${ROUTING}/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`);
    }

    // ── /summoner/:puuid ─────────────────────────────────────────
    if (path.startsWith("/summoner/")) {
      const puuid = path.split("/")[2];
      return proxy(res, apiKey,
        `${EUW}/lol/summoner/v4/summoners/by-puuid/${puuid}`);
    }

    // ── /rank/:summonerId ────────────────────────────────────────
    if (path.startsWith("/rank/")) {
      const id = path.split("/")[2];
      return proxy(res, apiKey,
        `${EUW}/lol/league/v4/entries/by-summoner/${id}`);
    }

    // ── /live/:puuid ─────────────────────────────────────────────
    if (path.startsWith("/live/")) {
      const puuid = path.split("/")[2];
      const r = await riotFetch(
        `${EUW}/lol/spectator/v5/active-games/by-summoner/${puuid}`, apiKey);
      if (r.status === 404) return res.status(200).json({ inGame: false });
      return res.status(r.status).json(await r.json());
    }

    // ── /matches/:puuid ──────────────────────────────────────────
    if (path.startsWith("/matches/")) {
      const puuid = path.split("/")[2];
      const count = qs || "5";
      return proxy(res, apiKey,
        `${ROUTING}/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}&queue=420`);
    }

    // ── /match/:matchId ──────────────────────────────────────────
    if (path.startsWith("/match/")) {
      const matchId = path.split("/")[2];
      return proxy(res, apiKey,
        `${ROUTING}/lol/match/v5/matches/${matchId}`);
    }

    return res.status(404).json({ error: "Endpoint desconocido" });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

async function riotFetch(url, apiKey) {
  return fetch(url, { headers: { "X-Riot-Token": apiKey } });
}

async function proxy(res, apiKey, url) {
  const r    = await riotFetch(url, apiKey);
  const data = await r.json();
  return res.status(r.status).json(data);
}

function enc(s) { return encodeURIComponent(decodeURIComponent(s)); }