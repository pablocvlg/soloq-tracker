// api/ingame.js
// Checks in-game status for all players in parallel.
// Called by the frontend every 30s.
// Returns current in-game states and who just left a game (so frontend can trigger postgame).

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const EUW = "euw1.api.riotgames.com";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const apiKey = process.env.RIOT_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey)
    return res.status(500).json({ error: "Missing env vars" });

  const supabase = createClient(sbUrl, sbKey);

  // Get all players from DB (we need their puuids)
  const { data: players, error } = await supabase
    .from("players")
    .select("puuid, game_name, in_game");
  if (error || !players?.length)
    return res.status(500).json({ error: "Could not load players" });

  // Check all players in parallel — well within 20 req/s limit
  const results = await Promise.all(players.map(async (p) => {
    const live = await riotGetOpt(EUW,
      `/lol/spectator/v5/active-games/by-summoner/${p.puuid}`, apiKey);
    return {
      puuid:       p.puuid,
      gameName:    p.game_name,
      wasInGame:   p.in_game,
      nowInGame:   !!(live?.gameId),
    };
  }));

  // Detect who just left a game
  const justLeft = results.filter(p => p.wasInGame && !p.nowInGame);
  const justJoined = results.filter(p => !p.wasInGame && p.nowInGame);

  // Batch update in_game in Supabase for anyone whose status changed
  const changed = results.filter(p => p.wasInGame !== p.nowInGame);
  if (changed.length > 0) {
    await Promise.all(changed.map(p =>
      supabase.from("players")
        .update({ in_game: p.nowInGame })
        .eq("puuid", p.puuid)
    ));
  }

  return res.status(200).json({
    players: results.map(p => ({ puuid: p.puuid, gameName: p.gameName, inGame: p.nowInGame })),
    justLeft:   justLeft.map(p => ({ puuid: p.puuid, gameName: p.gameName })),
    justJoined: justJoined.map(p => ({ puuid: p.puuid, gameName: p.gameName })),
  });
};

function riotGetOpt(hostname, path, apiKey) {
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
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}