// api/snapshot.js
// Fetches all player data from Riot API, stores it in Supabase,
// detects rank-change milestones, and caches match details.
// Should be called by a Vercel Cron (every hour) AND on manual refresh.
// Visitors read from Supabase — zero Riot API calls on page load.

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING    = "europe.api.riotgames.com";
const EUW        = "euw1.api.riotgames.com";
const DELAY_MS   = 350;
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

  // If not forced, check how old the data in Supabase is
  if (!force) {
    const { data: latest } = await supabase
      .from("players")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (latest) {
      const age = Date.now() - new Date(latest.updated_at).getTime();
      if (age < 55 * 60 * 1000) { // < 55 min → still fresh
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

// ── Full Riot API snapshot + Supabase write ──────────────────────────────
async function buildSnapshot(apiKey, supabase) {
  // Get previous scores for milestone detection
  const { data: prevPlayers } = await supabase.from("players").select("puuid, tier, rank, lp");
  const prevScores = {};
  for (const p of prevPlayers || []) {
    prevScores[p.puuid] = rankScore(p.tier, p.rank, p.lp);
  }

  const results = [];

  for (const p of PLAYERS) {
    try {
      const acc = await riotGet(ROUTING, `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
      await sleep(DELAY_MS);

      const sum = await riotGet(EUW, `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      const rankData = await riotGet(EUW, `/lol/league/v4/entries/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      const live = await riotGetOpt(EUW, `/lol/spectator/v5/active-games/by-summoner/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);

      const matchIds = await riotGet(ROUTING,
        `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?start=0&count=${MAX_MATCHES}&queue=420`, apiKey);
      await sleep(DELAY_MS);

      const solo = (rankData || []).find(r => r.queueType === "RANKED_SOLO_5x5");
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
        updated_at:      new Date().toISOString(),
      };

      // Upsert player row
      await supabase.from("players").upsert(playerRow, { onConflict: "puuid" });

      // Write rank history entry
      const score = rankScore(playerRow.tier, playerRow.rank, playerRow.lp);
      await supabase.from("rank_history").insert({
        puuid:       acc.puuid,
        tier:        playerRow.tier,
        rank:        playerRow.rank,
        lp:          playerRow.lp,
        wins:        playerRow.wins,
        losses:      playerRow.losses,
        score,
        recorded_at: new Date().toISOString(),
      });

      // Detect promotions / demotions
      await detectMilestones(supabase, acc.puuid, prevScores[acc.puuid], score, playerRow);

      // Queue match IDs for background fetch
      results.push({
        puuid:   acc.puuid,
        matchIds,
        rankData,
        gameName: acc.gameName,
        tagLine:  acc.tagLine,
        profileIconId: sum.profileIconId,
        summonerLevel: sum.summonerLevel,
        inGame:  !!(live?.gameId),
      });

      // Fetch any new matches we don't have yet
      const { data: knownMatches } = await supabase
        .from("matches").select("match_id").in("match_id", matchIds);
      const knownSet = new Set((knownMatches || []).map(m => m.match_id));

      for (const matchId of matchIds) {
        if (knownSet.has(matchId)) continue;
        try {
          const m = await riotGet(ROUTING, `/lol/match/v5/matches/${matchId}`, apiKey);
          await sleep(DELAY_MS);

          // Store full match data
          await supabase.from("matches").upsert({
            match_id:   matchId,
            fetched_at: new Date().toISOString(),
            data:       m.info.participants.reduce((obj, part) => {
              obj[part.puuid] = { win: part.win, champ: part.championName, k: part.kills, d: part.deaths, a: part.assists };
              return obj;
            }, {}),
          }, { onConflict: "match_id" });

          // Store per-player match result for all tracked players
          const trackedPuuids = results.map(r => r.puuid);
          for (const part of m.info.participants) {
            if (!trackedPuuids.includes(part.puuid)) continue;
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
        } catch (matchErr) {
          console.warn(`[snapshot] Match ${matchId}: ${matchErr.message}`);
        }
      }
    } catch (err) {
      console.warn(`[snapshot] ${p.name}#${p.tag}: ${err.message}`);
      results.push({ gameName: p.name, tagLine: p.tag, error: true });
    }
  }

  // Detect "surpassed" milestones (A passed B in rank)
  await detectSurpassedMilestones(supabase, prevScores);

  // Return the same shape as readPlayersFromDB
  return await readPlayersFromDB(supabase);
}

// ── Milestone detection ───────────────────────────────────────────────────
async function detectMilestones(supabase, puuid, prevScore, newScore, playerRow) {
  if (prevScore === undefined || prevScore === newScore) return;

  // Promotion: moved to higher tier
  const prevTierScore = Math.floor((prevScore ?? -10001) / 10000);
  const newTierScore  = Math.floor(newScore / 10000);

  if (newTierScore > prevTierScore && newScore > 0) {
    await supabase.from("milestones").insert({
      type:        "promoted",
      actor_puuid: puuid,
      detail:      { from_tier: getTierName(prevScore), to_tier: playerRow.tier + " " + playerRow.rank },
      occurred_at: new Date().toISOString(),
    });
  } else if (newTierScore < prevTierScore && prevScore > 0) {
    await supabase.from("milestones").insert({
      type:        "demoted",
      actor_puuid: puuid,
      detail:      { from_tier: getTierName(prevScore), to_tier: playerRow.tier + " " + playerRow.rank },
      occurred_at: new Date().toISOString(),
    });
  }
}

async function detectSurpassedMilestones(supabase, prevScores) {
  // Get new scores
  const { data: currentPlayers } = await supabase.from("players").select("puuid, game_name, tier, rank, lp");
  const newScores = {};
  for (const p of currentPlayers || []) {
    newScores[p.puuid] = rankScore(p.tier, p.rank, p.lp);
  }

  const puuids = Object.keys(newScores);
  for (const a of puuids) {
    for (const b of puuids) {
      if (a === b) continue;
      const prevA = prevScores[a] ?? -1;
      const prevB = prevScores[b] ?? -1;
      const newA  = newScores[a] ?? -1;
      const newB  = newScores[b] ?? -1;
      // A was below B, now A is above B
      if (prevA <= prevB && newA > newB && newA > 0) {
        await supabase.from("milestones").insert({
          type:         "surpassed",
          actor_puuid:  a,
          target_puuid: b,
          detail:       { actor_score: newA, target_score: newB },
          occurred_at:  new Date().toISOString(),
        });
      }
    }
  }
}

function getTierName(score) {
  if (score < 0) return "Unranked";
  const tierIdx = Math.floor(score / 10000);
  const tier = Object.keys(TIER_ORDER).find(k => TIER_ORDER[k] === tierIdx) || "?";
  const rankIdx = Math.floor((score % 10000) / 1000);
  const rank = Object.keys(RANK_ORDER).find(k => RANK_ORDER[k] === rankIdx) || "";
  return `${tier} ${rank}`.trim();
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