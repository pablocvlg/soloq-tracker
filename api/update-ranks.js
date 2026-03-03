// api/update-ranks.js
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const EUW      = "euw1.api.riotgames.com";
const DELAY_MS = 1100;

const TIER_ORDER = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:8,CHALLENGER:9 };
const RANK_ORDER = { IV:0,III:1,II:2,I:3 };
function rankScore(tier, rank, lp) {
  if (!tier) return -1;
  return (TIER_ORDER[tier]??-1)*10000 + (RANK_ORDER[rank]??0)*1000 + (lp||0);
}

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

  const supabase = createClient(sbUrl, sbKey);
  const now = new Date().toISOString();
  const log = [];

  const { data: players, error } = await supabase
    .from("players").select("puuid, game_name, tier, rank, lp, wins, losses");
  if (error || !players?.length)
    return res.status(500).json({ error: "Could not load players" });

  for (const p of players) {
    try {
      await sleep(DELAY_MS);
      const rankData = await riotGet(EUW,
        `/lol/league/v4/entries/by-puuid/${p.puuid}`, apiKey);

      const solo = (rankData || []).find(r => r.queueType === "RANKED_SOLO_5x5");
      if (!solo) { log.push(`${p.game_name}: unranked — skipped`); continue; }

      const newScore  = rankScore(solo.tier, solo.rank, solo.leaguePoints);
      const prevScore = rankScore(p.tier, p.rank, p.lp);

      await supabase.from("players").update({
        tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints,
        wins: solo.wins, losses: solo.losses, updated_at: now,
      }).eq("puuid", p.puuid);

      if (newScore !== prevScore) {
        await supabase.from("rank_history").insert({
          puuid: p.puuid, tier: solo.tier, rank: solo.rank,
          lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses,
          score: newScore, recorded_at: now,
        });
        const diff = newScore - prevScore;
        log.push(`${p.game_name}: ${p.tier} ${p.rank} ${p.lp}LP → ${solo.tier} ${solo.rank} ${solo.leaguePoints}LP (${diff>0?"+":""}${diff})`);
      } else {
        log.push(`${p.game_name}: sin cambio (${solo.tier} ${solo.rank} ${solo.leaguePoints}LP)`);
      }
    } catch(e) {
      log.push(`✗ ${p.game_name}: ${e.message}`);
    }
  }

  return res.status(200).json({ done: true, updated: log.filter(l=>l.includes("→")).length, log });
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
            return reject(new Error(`HTTP ${res.statusCode}`));
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