// api/backfill.js
// One-time endpoint to backfill last 10 ranked matches for specific players.
// Hit: /api/backfill
// Delete this file after running it once.

const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const ROUTING  = "europe.api.riotgames.com";
const EUW      = "euw1.api.riotgames.com";
const DELAY_MS = 1300;

const TARGETS = [
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
  const log = [];

  for (const p of TARGETS) {
    try {
      log.push(`→ ${p.name}#${p.tag}`);

      const acc = await riotGet(ROUTING,
        `/riot/account/v1/accounts/by-riot-id/${enc(p.name)}/${enc(p.tag)}`, apiKey);
      await sleep(DELAY_MS);
      log.push(`  puuid: ${acc.puuid}`);

      const matchIds = await riotGet(ROUTING,
        `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?start=0&count=25&queue=420`, apiKey);
      await sleep(DELAY_MS);
      log.push(`  found ${matchIds.length} match IDs`);

      for (const matchId of matchIds) {
        // Skip if already stored
        const { data: existing } = await supabase
          .from("matches").select("match_id").eq("match_id", matchId).single();
        if (existing) {
          log.push(`  skip ${matchId} (already stored)`);
          // But still make sure player_matches row exists
          const { data: pm } = await supabase
            .from("player_matches").select("match_id")
            .eq("puuid", acc.puuid).eq("match_id", matchId).single();
          if (!pm) {
            // Match is stored but player_matches row missing — add it
            const { data: mData } = await supabase
              .from("matches").select("data").eq("match_id", matchId).single();
            if (mData?.data?.[acc.puuid]) {
              const part = mData.data[acc.puuid];
              await supabase.from("player_matches").upsert({
                puuid: acc.puuid, match_id: matchId,
                win: part.win, champ: part.champ,
                kills: part.k, deaths: part.d, assists: part.a,
                played_at: new Date().toISOString(),
              }, { onConflict: "puuid,match_id" });
              log.push(`  fixed player_matches row for ${matchId}`);
            }
          }
          continue;
        }

        try {
          const m = await riotGet(ROUTING, `/lol/match/v5/matches/${matchId}`, apiKey);
          await sleep(DELAY_MS);

          const now = new Date().toISOString();
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

          // Store player_matches row for this player
          const part = participantMap[acc.puuid];
          if (part) {
            await supabase.from("player_matches").upsert({
              puuid: acc.puuid, match_id: matchId,
              win: part.win, champ: part.champ,
              kills: part.k, deaths: part.d, assists: part.a,
              played_at: new Date(m.info.gameStartTimestamp).toISOString(),
            }, { onConflict: "puuid,match_id" });
            log.push(`  stored ${matchId} — ${part.champ} ${part.win ? "W" : "L"}`);
          } else {
            log.push(`  stored ${matchId} — player not found as participant`);
          }
        } catch (err) {
          log.push(`  ERROR on ${matchId}: ${err.message}`);
        }
      }

      log.push(`  done ✓`);
    } catch (err) {
      log.push(`  FATAL: ${err.message}`);
    }
  }

  return res.status(200).json({ done: true, log });
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
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function enc(s)    { return encodeURIComponent(decodeURIComponent(s)); }