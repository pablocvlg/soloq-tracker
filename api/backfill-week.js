// api/backfill-week.js
// One-time use. Run once per player:
//   /api/backfill-week?player=0
//   /api/backfill-week?player=1
//   ... hasta ?player=12
// Then delete this file and push.

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING  = "europe.api.riotgames.com";
const DELAY_MS = 1600;
const WEEK_MS  = 168 * 60 * 60 * 1000;

const PLAYERS = [
  { name: "DDR4 2x16GB 3600", tag: "pepi"  },  // 0
  { name: "LaDragonaTragona",  tag: "AWA"   },  // 1
  { name: "lil yowi",          tag: "TS13"  },  // 2
  { name: "lil aitor",         tag: "EUW"   },  // 3
  { name: "comehigados",       tag: "EUW"   },  // 4
  { name: "pepi",              tag: "346"   },  // 5
  { name: "PapeldeCulo",       tag: "EUW"   },  // 6
  { name: "FinElGitΔno",       tag: "695"   },  // 7
  { name: "Xus17zgZ",          tag: "EUW"   },  // 8
  { name: "Si hombre",         tag: "TMAWA" },  // 9
  { name: "Epst3inBunny",      tag: "meow"  },  // 10
  { name: "her D is bigger",   tag: "cnc"   },  // 11
  { name: "BogΔvAnt3 Ð Oro",   tag: "EUW"  },  // 12
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const apiKey = process.env.RIOT_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey)
    return res.status(500).json({ error: "Missing env vars" });

  const idx = parseInt(req.query.player);
  if (isNaN(idx) || idx < 0 || idx >= PLAYERS.length)
    return res.status(400).json({ error: `player must be 0-${PLAYERS.length - 1}` });

  const p = PLAYERS[idx];
  const supabase = createClient(sbUrl, sbKey);
  const log = [];
  const startTime = Math.floor((Date.now() - WEEK_MS) / 1000);
  const now = new Date().toISOString();

  // All tracked puuids for cross-match detection
  const { data: allPlayers } = await supabase.from("players").select("puuid");
  const trackedPuuids = new Set((allPlayers || []).map(p => p.puuid));

  // Step 1: resolve puuid + fetch match IDs
  let acc, matchIds;
  try {
    acc = await riotGet(ROUTING,
      `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
    await sleep(DELAY_MS);
    matchIds = await riotGet(ROUTING,
      `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?queue=420&start=0&count=1&startTime=${startTime}`,
      apiKey);
    await sleep(DELAY_MS);
    log.push(`${acc.gameName}: ${matchIds.length} matches in last 7d`);
  } catch(e) {
    return res.status(500).json({ error: e.message, log });
  }

  // Step 2: check which are already in DB
  let knownSet = new Set();
  if (matchIds.length > 0) {
    const { data: known } = await supabase
    .from("player_matches").select("match_id")
    .eq("puuid", acc.puuid).in("match_id", matchIds);
    knownSet = new Set((known || []).map(m => m.match_id));
  }

  const newMatchIds = matchIds.filter(id => !knownSet.has(id));
  log.push(`Already in DB: ${knownSet.size} — New to fetch: ${newMatchIds.length}`);

  // Step 3: fetch each new match sequentially with delay
  for (const matchId of newMatchIds) {
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

      await supabase.from("matches").upsert({
        match_id: matchId, fetched_at: now, data: participantMap,
      }, { onConflict: "match_id" });

      const upserts = m.info.participants
        .filter(part => part.puuid === acc.puuid)
        .map(part => ({
          puuid:     part.puuid,
          match_id:  matchId,
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

      log.push(`✓ ${matchId} — ${upserts.map(u => u.champ).join(", ")}`);
    } catch(e) {
      log.push(`✗ ${matchId}: ${e.message}`);
    }
  }

  return res.status(200).json({ done: true, player: acc.gameName, log });
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }