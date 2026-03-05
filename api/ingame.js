// api/ingame.js
// Called by cron-job.org every 30s (or 1min).
// Checks all players in parallel. When someone leaves a game,
// updates their rank and stores the new match directly here (server-side).

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING = "europe.api.riotgames.com";
const EUW     = "euw1.api.riotgames.com";
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

const TIER_ORDER = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:8,CHALLENGER:9 };
const RANK_ORDER = { IV:0,III:1,II:2,I:3 };
function rankScore(tier, rank, lp) {
  if (!tier) return -1;
  return (TIER_ORDER[tier]??-1)*10000 + (RANK_ORDER[rank]??0)*1000 + (lp||0);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const apiKey = process.env.RIOT_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey)
    return res.status(500).json({ error: "Missing env vars" });

  const supabase = createClient(sbUrl, sbKey);

  const { data: players, error } = await supabase
    .from("players").select("puuid, game_name, in_game");
  if (error || !players?.length)
    return res.status(500).json({ error: "Could not load players" });

  // Check all players in parallel — 13 calls, well within 20 req/s
  const results = await Promise.all(players.map(async (p) => {
    const live = await riotGetOpt(EUW,
      `/lol/spectator/v5/active-games/by-summoner/${p.puuid}`, apiKey);
    return { puuid: p.puuid, gameName: p.game_name, wasInGame: p.in_game, nowInGame: !!(live?.gameId) };
  }));

  const justLeft  = results.filter(p => p.wasInGame && !p.nowInGame);
  const changed   = results.filter(p => p.wasInGame !== p.nowInGame);

  if (changed.length > 0) {
    await Promise.all(changed.map(p =>
      supabase.from("players").update({ in_game: p.nowInGame }).eq("puuid", p.puuid)
    ));
  }

  // Respond immediately — postgame runs async so cron doesn't timeout
  res.status(200).json({
    checked:    results.length,
    inGame:     results.filter(p => p.nowInGame).map(p => p.gameName),
    justLeft:   justLeft.map(p => p.gameName),
    justJoined: results.filter(p => !p.wasInGame && p.nowInGame).map(p => p.gameName),
  });

  // Run postgame for each player who just left (after response is sent)
  for (const p of justLeft) {
    runPostgame(p.puuid, apiKey, supabase).catch(e =>
      console.error(`[postgame] ${p.gameName}: ${e.message}`)
    );
  }
};

async function runPostgame(puuid, apiKey, supabase) {
  const now = new Date().toISOString();

  // Actualizar rango primero (esto sí está disponible inmediatamente)
  const rankData = await riotGet(EUW,
    `/lol/league/v4/entries/by-puuid/${puuid}`, apiKey).catch(() => null);

  const solo = (rankData || []).find(r => r.queueType === "RANKED_SOLO_5x5");
  if (solo) {
    const { data: prev } = await supabase
      .from("players").select("tier,rank,lp").eq("puuid", puuid).single();

    await supabase.from("players").update({
      tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints,
      wins: solo.wins, losses: solo.losses, updated_at: now,
    }).eq("puuid", puuid);

    const newScore  = rankScore(solo.tier, solo.rank, solo.leaguePoints);
    const prevScore = prev ? rankScore(prev.tier, prev.rank, prev.lp) : -2;
    if (newScore !== prevScore) {
      await supabase.from("rank_history").insert({
        puuid, tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints,
        wins: solo.wins, losses: solo.losses, score: newScore, recorded_at: now,
      });
    }
  }

  // Buscar la partida nueva con reintentos
  // Riot puede tardar hasta 5 min en indexar el match
  const ATTEMPTS   = 8;
  const DELAYS_SEC = [30, 45, 60, 90, 120, 150, 180, 240]; // esperas entre intentos

  const { data: allPlayers } = await supabase.from("players").select("puuid");
  const tracked = new Set((allPlayers || []).map(p => p.puuid));

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const waitMs = DELAYS_SEC[attempt] * 1000;
    console.log(`[postgame] ${puuid}: attempt ${attempt + 1}/${ATTEMPTS}, waiting ${DELAYS_SEC[attempt]}s...`);
    await sleep(waitMs);

    try {
      const matchIds = await riotGet(ROUTING,
        `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=10&queue=420`, apiKey);

      const { data: known } = await supabase
        .from("player_matches").select("match_id")
        .eq("puuid", puuid).in("match_id", matchIds);

      const knownSet   = new Set((known || []).map(m => m.match_id));
      const newMatchId = matchIds.find(id => !knownSet.has(id));

      if (!newMatchId) {
        console.log(`[postgame] ${puuid}: no new match yet (attempt ${attempt + 1})`);
        continue; // reintenta
      }

      const m = await riotGet(ROUTING, `/lol/match/v5/matches/${newMatchId}`, apiKey);

      const participantMap = m.info.participants.reduce((obj, part) => {
        obj[part.puuid] = {
          win: part.win, champ: part.championName,
          k: part.kills, d: part.deaths, a: part.assists,
        };
        return obj;
      }, {});

      await supabase.from("matches").upsert(
        { match_id: newMatchId, fetched_at: now, data: participantMap },
        { onConflict: "match_id" }
      );

      const upserts = m.info.participants
        .filter(p => tracked.has(p.puuid))
        .map(p => ({
          puuid: p.puuid, match_id: newMatchId, win: p.win, champ: p.championName,
          kills: p.kills, deaths: p.deaths, assists: p.assists,
          played_at: new Date(m.info.gameStartTimestamp).toISOString(),
        }));

      if (upserts.length) {
        await supabase.from("player_matches")
          .upsert(upserts, { onConflict: "puuid,match_id" });
      }

      console.log(`[postgame] ${puuid}: stored ${newMatchId} on attempt ${attempt + 1}`);
      return; // ✓ éxito, salimos
    } catch (e) {
      console.error(`[postgame] ${puuid} attempt ${attempt + 1} error: ${e.message}`);
    }
  }

  console.error(`[postgame] ${puuid}: failed to find new match after ${ATTEMPTS} attempts`);
}

function riotGet(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode} — ${hostname}${path}`));
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("JSON parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function riotGetOpt(hostname, path, apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode >= 400) return resolve(null);
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }