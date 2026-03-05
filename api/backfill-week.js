// api/backfill-week.js
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING  = "europe.api.riotgames.com";
const DELAY_MS = 1300;

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
  const now      = new Date().toISOString();
  const log      = [];
  let   totalNew = 0;

  // ── 1. Load all tracked players ──────────────────────────────────────────
  const { data: players, error } = await supabase
    .from("players")
    .select("puuid, game_name");
  if (error || !players?.length)
    return res.status(500).json({ error: "Could not load players" });

  const trackedPuuids = new Set(players.map(p => p.puuid));
  log.push(`Loaded ${players.length} players`);

  // ── 2. Process each player independently ─────────────────────────────────
  for (const p of players) {
    log.push(`--- ${p.game_name} ---`);

    // Fetch last 5 ranked match IDs for this player
    let matchIds;
    try {
      await sleep(DELAY_MS);
      matchIds = await riotGet(
        ROUTING,
        `/lol/match/v5/matches/by-puuid/${p.puuid}/ids?queue=420&start=0&count=5`,
        apiKey
      );
      log.push(`${p.game_name}: ${matchIds.length} match IDs fetched`);
    } catch (e) {
      log.push(`✗ ${p.game_name}: failed to fetch match IDs — ${e.message}`);
      continue;
    }

    if (!matchIds.length) continue;

    // Check which are already stored for this specific player
    const { data: known } = await supabase
      .from("player_matches")
      .select("match_id")
      .eq("puuid", p.puuid)
      .in("match_id", matchIds);
    const knownSet = new Set((known || []).map(m => m.match_id));

    const toFetch = matchIds.filter(id => !knownSet.has(id));
    log.push(`Already in DB: ${knownSet.size} — New to fetch: ${toFetch.length}`);

    // Fetch and store each new match
    for (const matchId of toFetch) {
      try {
        await sleep(DELAY_MS);
        const m = await riotGet(ROUTING, `/lol/match/v5/matches/${matchId}`, apiKey);

        const participantMap = m.info.participants.reduce((obj, part) => {
          obj[part.puuid] = {
            win: part.win, champ: part.championName,
            k: part.kills, d: part.deaths, a: part.assists,
          };
          return obj;
        }, {});

        await supabase.from("matches").upsert(
          { match_id: matchId, fetched_at: now, data: participantMap },
          { onConflict: "match_id" }
        );

        // Only store the row for this specific player, not all participants
        const part = m.info.participants.find(part => part.puuid === p.puuid);
        if (part) {
          await supabase.from("player_matches").upsert({
            puuid:     p.puuid,
            match_id:  matchId,
            win:       part.win,
            champ:     part.championName,
            kills:     part.kills,
            deaths:    part.deaths,
            assists:   part.assists,
            played_at: new Date(m.info.gameStartTimestamp).toISOString(),
          }, { onConflict: "puuid,match_id" });

          log.push(`✓ ${matchId} — ${part.championName} ${part.win ? "W" : "L"}`);
          totalNew++;
        }
      } catch (e) {
        log.push(`✗ ${matchId}: ${e.message}`);
      }
    }
  }

  return res.status(200).json({ done: true, newMatches: totalNew, log });
};

function riotGet(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname, path, method: "GET",
        headers: { "X-Riot-Token": apiKey, "Accept": "application/json" },
      },
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }