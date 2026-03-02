// api/data.js
const { createClient } = require("@supabase/supabase-js");

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

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: "Supabase not configured" });

  const supabase = createClient(sbUrl, sbKey);
  const type     = req.query.type || "players";

  try {
    switch (type) {

      case "players": {
        const { data: players, error } = await supabase.from("players").select("*");
        if (error) throw error;

        const puuids = players.map(p => p.puuid);
        const { data: pMatches } = await supabase
          .from("player_matches")
          .select("puuid, win, champ, kills, deaths, assists, played_at")
          .in("puuid", puuids)
          .order("played_at", { ascending: true });

        const matchesByPuuid = {};
        for (const m of pMatches || []) {
          if (!matchesByPuuid[m.puuid]) matchesByPuuid[m.puuid] = [];
          matchesByPuuid[m.puuid].push(m);
        }
        // Keep last 10
        for (const puuid of Object.keys(matchesByPuuid)) {
          const all = matchesByPuuid[puuid];
          matchesByPuuid[puuid] = all.slice(Math.max(0, all.length - 10));
        }

        const result = players.map(p => ({
          puuid:         p.puuid,
          gameName:      p.game_name,
          tagLine:       p.tag_line,
          profileIconId: p.profile_icon_id,
          summonerLevel: p.summoner_level,
          rankData: p.tier ? [{
            queueType:    "RANKED_SOLO_5x5",
            tier:         p.tier,
            rank:         p.rank,
            leaguePoints: p.lp,
            wins:         p.wins,
            losses:       p.losses,
          }] : [],
          inGame:        p.in_game,
          recentMatches: (matchesByPuuid[p.puuid] || []).map(m => ({
            win: m.win, champ: m.champ, k: m.kills, d: m.deaths, a: m.assists,
          })),
        }));

        const updatedAt = players[0]?.updated_at
          ? new Date(players[0].updated_at).getTime() : Date.now();
        return res.status(200).json({ players: result, updatedAt, cached: true });
      }

      case "weekly": {
        const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();

        const { data: current } = await supabase
          .from("players")
          .select("puuid, game_name, tag_line, tier, rank, lp, wins, losses");

        const { data: histRows } = await supabase
          .from("rank_history")
          .select("puuid, lp, tier, rank, recorded_at")
          .gte("recorded_at", weekAgo)
          .order("recorded_at", { ascending: true });
        const oldByPuuid = {};
        for (const row of histRows||[]) {
          if (!oldByPuuid[row.puuid]) oldByPuuid[row.puuid] = row;
        }

        const { data: recentMatches } = await supabase
          .from("player_matches")
          .select("puuid, win")
          .gte("played_at", weekAgo);
        const matchStats = {};
        for (const m of recentMatches||[]) {
          if (!matchStats[m.puuid]) matchStats[m.puuid] = { wins:0, losses:0 };
          if (m.win) matchStats[m.puuid].wins++; else matchStats[m.puuid].losses++;
        }

        const weekly = (current||[]).map(p => {
          const prev      = oldByPuuid[p.puuid];
          const nowScore  = rankScore(p.tier, p.rank, p.lp);
          const prevScore = prev ? rankScore(prev.tier, prev.rank, prev.lp) : nowScore;
          const lpGain    = nowScore - prevScore;
          const ms        = matchStats[p.puuid] || { wins:0, losses:0 };
          const wPlayed   = ms.wins + ms.losses;
          return {
            puuid:       p.puuid,
            gameName:    p.game_name,
            tagLine:     p.tag_line,
            lpGain,
            gamesPlayed: wPlayed,
            weekWins:    ms.wins,
            weekLosses:  ms.losses,
            weekWr:      wPlayed > 0 ? Math.round(ms.wins/wPlayed*100) : null,
          };
        });
        return res.status(200).json(weekly);
      }

      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (e) {
    console.error("[data]", e.message);
    return res.status(500).json({ error: e.message });
  }
};