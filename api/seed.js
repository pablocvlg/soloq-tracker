// api/seed.js — run once at /api/seed then delete this file

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING  = "europe.api.riotgames.com";
const EUW      = "euw1.api.riotgames.com";
const DELAY_MS = 600;

const PLAYERS = [
  { name: "DDR4 2x16GB 3600", tag: "pepi"  },
  { name: "LaDragonaTragona",  tag: "AWA"   },
  { name: "lil yowi",          tag: "TS13"  },
  { name: "lil aitor",         tag: "EUW"   },
  { name: "comehigados",       tag: "EUW"   },
  { name: "pepi",              tag: "346"   },
  { name: "PapeldeCulo",       tag: "EUW"   },
  { name: "FinElGitΔno",       tag: "695"   },
  { name: "Xus17zgZ",          tag: "EUW"   },
  { name: "Si hombre",         tag: "TMAWA" },
  { name: "Epst3inBunny",      tag: "meow"  },
  { name: "her D is bigger",   tag: "cnc"   },
  { name: "BogΔvAnt3 Ð Oro",   tag: "EUW"  },
];

const CORS = { "Content-Type": "application/json" };

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  const apiKey = process.env.RIOT_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey) return res.status(500).json({ error: "Missing env vars" });

  const supabase = createClient(sbUrl, sbKey);
  const log = [];

  for (const p of PLAYERS) {
    try {
      const acc = await riotGet(ROUTING,
        `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
      await sleep(DELAY_MS);
      const sum = await riotGet(EUW,
        `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);
      const rankData = await riotGet(EUW,
        `/lol/league/v4/entries/by-puuid/${acc.puuid}`, apiKey);
      await sleep(DELAY_MS);
      const solo = (rankData||[]).find(r => r.queueType === "RANKED_SOLO_5x5");
      await supabase.from("players").upsert({
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
        in_game:         false,
        updated_at:      new Date().toISOString(),
      }, { onConflict: "puuid" });
      log.push(`✓ ${acc.gameName}#${acc.tagLine} — ${solo?.tier||"Unranked"} ${solo?.rank||""} ${solo?.leaguePoints||0}LP`);
    } catch(e) {
      log.push(`✗ ${p.name}#${p.tag}: ${e.message}`);
    }
  }
  return res.status(200).json({ done: true, log });
};

function riotGet(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { "X-Riot-Token": apiKey, "Accept": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("JSON parse")); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }