// api/postgame.js
// Called after a player leaves a game.
// Updates their rank and tries to store 1 new match.
// GET /api/postgame?puuid=xxx

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING = "europe.api.riotgames.com";
const EUW     = "euw1.api.riotgames.com";

const TIER_ORDER = { IRON:0, BRONZE:1, SILVER:2, GOLD:3, PLATINUM:4, EMERALD:5, DIAMOND:6, MASTER:7, GRANDMASTER:8, CHALLENGER:9 };
const RANK_ORDER = { IV:0, III:1, II:2, I:3 };
function rankScore(tier, rank, lp) {
  if (!tier) return -1;
  return (TIER_ORDER[tier] ?? -1) * 10000 + (RANK_ORDER[rank] ?? 0) * 1000 + (lp || 0);
}

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

  const puuid = req.query.puuid;
  if (!puuid) return res.status(400).json({ error: "puuid required" });

  const supabase = createClient(sbUrl, sbKey);
  const now = new Date().toISOString();
  const log = [];

  try {
    // 1. Fetch updated rank — in parallel with match list fetch
    const [rankData, matchIds] = await Promise.all([
      riotGet(EUW, `/lol/league/v4/entries/by-puuid/${puuid}`, apiKey),
      riotGet(ROUTING, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5&queue=420`, apiKey),
    ]);
    log.push(`rank + match list fetched`);

    // 2. Update rank in DB
    const solo = (rankData || []).find(r => r.queueType === "RANKED_SOLO_5x5");
    if (solo) {
      const { data: prev } = await supabase
        .from("players").select("tier, rank, lp").eq("puuid", puuid).single();

      await supabase.from("players").update({
        tier:       solo.tier,
        rank:       solo.rank,
        lp:         solo.leaguePoints,
        wins:       solo.wins,
        losses:     solo.losses,
        updated_at: now,
      }).eq("puuid", puuid);

      // Write rank_history if rank changed
      const newScore  = rankScore(solo.tier, solo.rank, solo.leaguePoints);
      const prevScore = prev ? rankScore(prev.tier, prev.rank, prev.lp) : -2;
      if (newScore !== prevScore) {
        await supabase.from("rank_history").insert({
          puuid, tier: solo.tier, rank: solo.rank,
          lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses,
          score: newScore, recorded_at: now,
        });
        log.push(`rank updated: ${solo.tier} ${solo.rank} ${solo.leaguePoints}LP`);
      } else {
        log.push(`rank unchanged`);
      }
    }

    // 3. Check which match IDs we already have stored
    const { data: knownMatches } = await supabase
      .from("player_matches")
      .select("match_id")
      .eq("puuid", puuid)
      .in("match_id", matchIds);
    const knownSet = new Set((knownMatches || []).map(m => m.match_id));

    // Find the newest match ID we don't have yet
    const newMatchId = matchIds.find(id => !knownSet.has(id));

    if (!newMatchId) {
      log.push(`no new match found`);
      return res.status(200).json({ updated: true, newMatch: false, log });
    }

    // 4. Fetch and store the new match
    const m = await riotGet(ROUTING, `/lol/match/v5/matches/${newMatchId}`, apiKey);
    log.push(`fetched match ${newMatchId}`);

    // Get all tracked puuids to store their results too
    const { data: allPlayers } = await supabase.from("players").select("puuid");
    const trackedPuuids = new Set((allPlayers || []).map(p => p.puuid));

    const participantMap = m.info.participants.reduce((obj, part) => {
      obj[part.puuid] = {
        win: part.win, champ: part.championName,
        k: part.kills, d: part.deaths, a: part.assists,
      };
      return obj;
    }, {});

    // Store full match
    await supabase.from("matches").upsert({
      match_id: newMatchId, fetched_at: now, data: participantMap,
    }, { onConflict: "match_id" });

    // Store player_matches rows for all tracked players in this match
    const upserts = m.info.participants
      .filter(part => trackedPuuids.has(part.puuid))
      .map(part => ({
        puuid:     part.puuid,
        match_id:  newMatchId,
        win:       part.win,
        champ:     part.championName,
        kills:     part.kills,
        deaths:    part.deaths,
        assists:   part.assists,
        played_at: new Date(m.info.gameStartTimestamp).toISOString(),
      }));

    if (upserts.length > 0) {
      await supabase.from("player_matches")
        .upsert(upserts, { onConflict: "puuid,match_id" });
    }

    const playerResult = participantMap[puuid];
    log.push(`stored match — ${playerResult?.champ} ${playerResult?.win ? "W" : "L"}`);

    return res.status(200).json({ updated: true, newMatch: true, match: playerResult, log });

  } catch (e) {
    console.error("[postgame]", e.message);
    return res.status(500).json({ error: e.message, log });
  }
};

function riotGet(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET",
        headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode} — ${hostname}${path}`));
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("JSON parse error")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}