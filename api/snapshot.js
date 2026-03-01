// api/snapshot.js
// Smart snapshot: only calls Riot API for what has actually changed.
// Per player:
//   - Always fetches: rank, live game status (cheap calls)
//   - Match list: only fetched if rank changed OR forced
//   - Match details: only fetched for match IDs not already in Supabase
// This keeps calls well under rate limits even at 5-10 min intervals.

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING    = "europe.api.riotgames.com";
const EUW        = "euw1.api.riotgames.com";
const DELAY_MS   = 1200;
const MAX_MATCHES = 10;

const PLAYERS = [
  { name: "DDR4 2x16GB 3600", tag: "pepi"   },
  { name: "LaDragonaTragona",  tag: "AWA"    },
  { name: "lil yowi",          tag: "TS13"   },
  { name: "lil aitor",         tag: "EUW"    },
  { name: "comehigados",       tag: "EUW"    },
  { name: "pepi",              tag: "346"    },
  { name: "PapeldeCulo",       tag: "EUW"    },
  { name: "FinElGitΔno",       tag: "695"    },
  { name: "Xus17zgZ",          tag: "EUW"    },
  { name: "Si hombre",         tag: "TMAWA"  },
  { name: "Epst3inBunny",      tag: "meow"   },
  { name: "her D is bigger",   tag: "cnc"    },
];

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

// In-memory lock so parallel requests don't double-fetch
let building = false;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const apiKey = process.env.RIOT_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_KEY; // service_role key — never expose to client
  if (!apiKey) return res.status(500).json({ error: "RIOT_API_KEY not set" });
  if (!sbUrl || !sbKey) return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SERVICE_KEY not set" });

  const supabase = createClient(sbUrl, sbKey);
  const force    = req.query.force === "1";

  // If not forced, check how old the data in Supabase is.
  // Allow re-run if data is older than 8 minutes (supports frequent cron intervals).
  if (!force) {
    const { data: latest } = await supabase
      .from("players")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      const age = Date.now() - new Date(latest.updated_at).getTime();
      if (age < 8 * 60 * 1000) { // < 8 min → still fresh, skip entirely
        const players = await readPlayersFromDB(supabase);
        return res.status(200).json({ players, updatedAt: new Date(latest.updated_at).getTime(), cached: true });
      }
    }
  }

  if (building) {
    // Wait for the other request to finish then return from DB
    const t0 = Date.now();
    while (building && Date.now() - t0 < 25000) await sleep(400);
    const players = await readPlayersFromDB(supabase);
    return res.status(200).json({ players, updatedAt: Date.now(), cached: true });
  }

  building = true;
  try {
    console.log("[snapshot] Starting full Riot fetch...");
    const players = await buildSnapshot(apiKey, supabase);
    return res.status(200).json({ players, updatedAt: Date.now(), cached: false });
  } catch (e) {
    console.error("[snapshot] Fatal error:", e.message);
    // Fall back to whatever is in Supabase
    const players = await readPlayersFromDB(supabase);
    if (players.length) return res.status(200).json({ players, updatedAt: Date.now(), cached: true, stale: true });
    return res.status(500).json({ error: e.message });
  } finally {
    building = false;
  }
};

// ── Read players + their recent matches from Supabase ─────────────────────
async function readPlayersFromDB(supabase) {
  const { data: players, error } = await supabase
    .from("players")
    .select("*");
  if (error || !players) return [];

  // For each player, get their last 10 match results
  const puuids = players.map(p => p.puuid);
  const { data: pMatches } = await supabase
    .from("player_matches")
    .select("puuid, match_id, win, champ, kills, deaths, assists, played_at")
    .in("puuid", puuids)
    .order("played_at", { ascending: false });

  const matchesByPuuid = {};
  for (const m of pMatches || []) {
    if (!matchesByPuuid[m.puuid]) matchesByPuuid[m.puuid] = [];
    if (matchesByPuuid[m.puuid].length < MAX_MATCHES) matchesByPuuid[m.puuid].push(m);
  }

  return players.map(p => ({
    puuid:         p.puuid,
    gameName:      p.game_name,
    tagLine:       p.tag_line,
    profileIconId: p.profile_icon_id,
    summonerLevel: p.summoner_level,
    rankData: p.tier ? [{
      queueType:     "RANKED_SOLO_5x5",
      tier:          p.tier,
      rank:          p.rank,
      leaguePoints:  p.lp,
      wins:          p.wins,
      losses:        p.losses,
    }] : [],
    inGame:        p.in_game,
    recentMatches: (matchesByPuuid[p.puuid] || []).reverse().map(m => ({
      win:   m.win,
      champ: m.champ,
      k:     m.kills,
      d:     m.deaths,
      a:     m.assists,
    })),
  }));
}

// ── Smart snapshot ────────────────────────────────────────────────────────
// API calls per player per run:
//   ALWAYS (4 calls): account, summoner, rank, live
//   ONLY IF new matches exist (1 + N calls): match list, then only new match details
// On a quiet day with no games played: ~48 calls total for 12 players.
// On an active day: 48 + (new matches × 1 each).
async function buildSnapshot(apiKey, supabase) {
  // Load current DB state for all players in one query — used to detect changes
  const { data: prevPlayers } = await supabase
    .from("players")
    .select("puuid, tier, rank, lp, wins, losses");
  const prevByPuuid = {};
  for (const p of prevPlayers || []) prevByPuuid[p.puuid] = p;

  const trackedPuuids = new Set();
  const now = new Date().toISOString();

  for (const p of PLAYERS) {
    try {
      // 1. Account (needed to get puuid — skip if already known)
      const acc = await riotGet(ROUTING,
        `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
      await sleep(DELAY_MS);
      trackedPuuids.add(acc.puuid);

      // 2. Summoner (icon + level)
      const sum = await riotGet(EUW,
        `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      // 3. Rank
      const rankData = await riotGet(EUW,
        `/lol/league/v4/entries/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      // 4. Live game
      const live = await riotGetOpt(EUW,
        `/lol/spectator/v5/active-games/by-summoner/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      const solo = (rankData || []).find(r => r.queueType === "RANKED_SOLO_5x5");
      const prev = prevByPuuid[acc.puuid];

      const playerRow = {
        puuid:           acc.puuid,
        game_name:       acc.gameName,
        tag_line:        acc.tagLine,
        profile_icon_id: sum.profileIconId,
        summoner_level:  sum.summonerLevel,
        tier:            solo?.tier   || null,
        rank:            solo?.rank   || null,
        lp:              solo?.leaguePoints ?? 0,
        wins:            solo?.wins   || 0,
        losses:          solo?.losses || 0,
        in_game:         !!(live?.gameId),
        updated_at:      now,
      };

      await supabase.from("players").upsert(playerRow, { onConflict: "puuid" });

      // Write rank history only when rank/LP actually changed
      const newScore  = rankScore(playerRow.tier, playerRow.rank, playerRow.lp);
      const prevScore = prev ? rankScore(prev.tier, prev.rank, prev.lp) : -2;
      const rankChanged = newScore !== prevScore;

      if (rankChanged) {
        await supabase.from("rank_history").insert({
          puuid:       acc.puuid,
          tier:        playerRow.tier,
          rank:        playerRow.rank,
          lp:          playerRow.lp,
          wins:        playerRow.wins,
          losses:      playerRow.losses,
          score:       newScore,
          recorded_at: now,
        });
        console.log(`[snapshot] ${acc.gameName}: rank changed (${prevScore} → ${newScore})`);
      }

      // 5. Match list — only fetch if wins+losses increased (new game played)
      const prevWins   = prev?.wins   ?? playerRow.wins;
      const prevLosses = prev?.losses ?? playerRow.losses;
      const gamesPlayed = (playerRow.wins + playerRow.losses) - (prevWins + prevLosses);
      const hasNewGames = gamesPlayed > 0;

      if (hasNewGames) {
        const matchIds = await riotGet(ROUTING,
          `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?start=0&count=${MAX_MATCHES}&queue=420`,
          apiKey);
        await sleep(DELAY_MS);

        // Only fetch details for match IDs we don't already have
        const { data: knownMatches } = await supabase
          .from("matches").select("match_id").in("match_id", matchIds);
        const knownSet = new Set((knownMatches || []).map(m => m.match_id));

        for (const matchId of matchIds) {
          if (knownSet.has(matchId)) continue; // already stored, skip
          try {
            const m = await riotGet(ROUTING, `/lol/match/v5/matches/${matchId}`, apiKey);
            await sleep(DELAY_MS);

            // Cache full match
            await supabase.from("matches").upsert({
              match_id:   matchId,
              fetched_at: now,
              data: m.info.participants.reduce((obj, part) => {
                obj[part.puuid] = { win: part.win, champ: part.championName, k: part.kills, d: part.deaths, a: part.assists };
                return obj;
              }, {}),
            }, { onConflict: "match_id" });

            // Store result for every tracked player in this match
            for (const part of m.info.participants) {
              if (!trackedPuuids.has(part.puuid)) continue;
              await supabase.from("player_matches").upsert({
                puuid:     part.puuid,
                match_id:  matchId,
                win:       part.win,
                champ:     part.championName,
                kills:     part.kills,
                deaths:    part.deaths,
                assists:   part.assists,
                played_at: new Date(m.info.gameStartTimestamp).toISOString(),
              }, { onConflict: "puuid,match_id" });
            }
            console.log(`[snapshot] Stored match ${matchId}`);
          } catch (matchErr) {
            console.warn(`[snapshot] Match ${matchId}: ${matchErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[snapshot] ${p.name}#${p.tag}: ${err.message}`);
    }
  }

  return await readPlayersFromDB(supabase);
}


// ── HTTP helpers ─────────────────────────────────────────────────────────
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
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

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
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }