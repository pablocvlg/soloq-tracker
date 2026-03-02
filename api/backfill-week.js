// api/backfill-week.js
// One-time use. Run 3 times in order:
//   /api/backfill-week?group=1  → wait for JSON
//   /api/backfill-week?group=2  → wait for JSON
//   /api/backfill-week?group=3  → wait for JSON
// Then delete this file and push.

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING  = "europe.api.riotgames.com";
const DELAY_MS = 1600; // 75% of 100 req/2min limit
const WEEK_MS  = 168 * 60 * 60 * 1000;

const ALL_PLAYERS = [
  // Group 1
  { name: "DDR4 2x16GB 3600", tag: "pepi"  },
  { name: "LaDragonaTragona",  tag: "AWA"   },
  { name: "lil yowi",          tag: "TS13"  },
  { name: "lil aitor",         tag: "EUW"   },
  { name: "comehigados",       tag: "EUW"   },
  // Group 2
  { name: "pepi",              tag: "346"   },
  { name: "PapeldeCulo",       tag: "EUW"   },
  { name: "FinElGitΔno",       tag: "695"   },
  { name: "Xus17zgZ",          tag: "EUW"   },
  // Group 3
  { name: "Si hombre",         tag: "TMAWA" },
  { name: "Epst3inBunny",      tag: "meow"  },
  { name: "her D is bigger",   tag: "cnc"   },
  { name: "BogΔvAnt3 Ð Oro",   tag: "EUW"  },
];

const GROUPS = {
  "1": ALL_PLAYERS.slice(0, 5),
  "2": ALL_PLAYERS.slice(5, 9),
  "3": ALL_PLAYERS.slice(9, 13),
};

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

  const group = req.query.group || "1";
  const players = GROUPS[group];
  if (!players) return res.status(400).json({ error: "group must be 1, 2 or 3" });

  const supabase = createClient(sbUrl, sbKey);
  const log = [];
  const startTime = Math.floor((Date.now() - WEEK_MS) / 1000);
  const now = new Date().toISOString();

  // All tracked puuids (to store cross-match data for teammates)
  const { data: allPlayers } = await supabase.from("players").select("puuid");
  const trackedPuuids = new Set((allPlayers || []).map(p => p.puuid));

  // Step 1: resolve puuids + fetch match ID lists in parallel (just 4-5 calls, safe)
  const resolved = await Promise.all(players.map(async (p) => {
    try {
      const acc = await riotGet(ROUTING,
        `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
      const matchIds = await riotGet(ROUTING,
        `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?queue=420&start=0&count=20&startTime=${startTime}`,
        apiKey);
      log.push(`${acc.gameName}: ${matchIds.length} matches in last 7d`);
      return { puuid: acc.puuid, gameName: acc.gameName, matchIds };
    } catch(e) {
      log.push(`✗ ${p.name}#${p.tag}: ${e.message}`);
      return null;
    }
  }));

  // Pause after parallel burst before sequential calls
  await sleep(DELAY_MS * 2);

  // Deduplicate match IDs across the group
  const allMatchIds = [...new Set(resolved.filter(Boolean).flatMap(r => r.matchIds))];
  log.push(`Unique matches to check: ${allMatchIds.length}`);

  // Step 2: check which are already in DB
  let knownSet = new Set();
  if (allMatchIds.length > 0) {
    const { data: known } = await supabase
      .from("matches").select("match_id").in("match_id", allMatchIds);
    knownSet = new Set((known || []).map(m => m.match_id));
  }

  const newMatchIds = allMatchIds.filter(id => !knownSet.has(id));
  log.push(`New matches to fetch: ${newMatchIds.length}`);

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
        .filter(part => trackedPuuids.has(part.puuid))
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

  return res.status(200).json({ done: true, group, log });
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }