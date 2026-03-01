// api/data.js
// Fast read-only endpoint — all reads from Supabase, zero Riot API calls.
// Routes:
//   GET /api/data?type=players           → current leaderboard + recent matches
//   GET /api/data?type=weekly            → 7-day LP/wins/WR delta per player
//   GET /api/data?type=standings_delta   → position change vs ~24h ago

const { createClient } = require("@supabase/supabase-js");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json",
};

const TIER_ORDER = { IRON:0, BRONZE:1, SILVER:2, GOLD:3, PLATINUM:4, EMERALD:5, DIAMOND:6, MASTER:7, GRANDMASTER:8, CHALLENGER:9 };
const RANK_ORDER = { IV:0, III:1, II:2, I:3 };
function rankScore(tier, rank, lp) {
  if (!tier) return -1;
  return (TIER_ORDER[tier] ?? -1) * 10000 + (RANK_ORDER[rank] ?? 0) * 1000 + (lp || 0);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end(); }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: "Supabase not configured" });

  const supabase = createClient(sbUrl, sbKey);
  const type     = req.query.type || "players";

  try {
    switch (type) {

      // ── Current leaderboard ──────────────────────────────────────────────
      case "players": {
        const { data: players, error } = await supabase
          .from("players")
          .select("*");
        if (error) throw error;

        const puuids = players.map(p => p.puuid);
        const { data: pMatches } = await supabase
          .from("player_matches")
          .select("puuid, win, champ, kills, deaths, assists, played_at")
          .in("puuid", puuids)
          .order("played_at", { ascending: false });

        const matchesByPuuid = {};
        for (const m of pMatches || []) {
          if (!matchesByPuuid[m.puuid]) matchesByPuuid[m.puuid] = [];
          if (matchesByPuuid[m.puuid].length < 10) matchesByPuuid[m.puuid].push(m);
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
          recentMatches: (matchesByPuuid[p.puuid] || []).reverse().map(m => ({
            win: m.win, champ: m.champ, k: m.kills, d: m.deaths, a: m.assists,
          })),
        }));

        const updatedAt = players[0]?.updated_at
          ? new Date(players[0].updated_at).getTime()
          : Date.now();
        return res.status(200).json({ players: result, updatedAt, cached: true });
      }

      // ── Weekly delta ─────────────────────────────────────────────────────
      case "weekly": {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const { data: current } = await supabase
          .from("players")
          .select("puuid, game_name, tag_line, tier, rank, lp, wins, losses");

        // Earliest rank_history record per player from within the last 7 days
        // Used only for LP gain calculation
        const { data: histRows } = await supabase
          .from("rank_history")
          .select("puuid, score, recorded_at")
          .gte("recorded_at", weekAgo)
          .order("recorded_at", { ascending: true });

        const oldByPuuid = {};
        for (const row of histRows || []) {
          if (!oldByPuuid[row.puuid]) oldByPuuid[row.puuid] = row;
        }

        // Count actual games played in the last 7 days from player_matches
        const { data: recentMatches } = await supabase
          .from("player_matches")
          .select("puuid, win")
          .gte("played_at", weekAgo);

        const matchStatsByPuuid = {};
        for (const m of recentMatches || []) {
          if (!matchStatsByPuuid[m.puuid]) matchStatsByPuuid[m.puuid] = { wins: 0, losses: 0 };
          if (m.win) matchStatsByPuuid[m.puuid].wins++;
          else matchStatsByPuuid[m.puuid].losses++;
        }

        const weekly = (current || []).map(p => {
          const prev      = oldByPuuid[p.puuid];
          const nowScore  = rankScore(p.tier, p.rank, p.lp);
          const prevScore = prev ? prev.score : nowScore;
          const lpGain    = nowScore - prevScore;

          // Games played counted directly from match history
          const mStats  = matchStatsByPuuid[p.puuid] || { wins: 0, losses: 0 };
          const wWins   = mStats.wins;
          const wLosses = mStats.losses;
          const wPlayed = wWins + wLosses;

          return {
            puuid:       p.puuid,
            gameName:    p.game_name,
            tagLine:     p.tag_line,
            lpGain,
            gamesPlayed: wPlayed,
            weekWins:    wWins,
            weekLosses:  wLosses,
            weekWr:      wPlayed > 0 ? Math.round(wWins / wPlayed * 100) : null,
          };
        });

        return res.status(200).json(weekly);
      }

      // ── Standings delta (position change vs ~24h ago) ────────────────────
      case "standings_delta": {
        // Get current standings
        const { data: current } = await supabase
          .from("players")
          .select("puuid, tier, rank, lp");
        if (!current?.length) return res.status(200).json([]);

        // Sort current by rank score → position today
        const todaySorted = [...current].sort(
          (a, b) => rankScore(b.tier, b.rank, b.lp) - rankScore(a.tier, a.rank, a.lp)
        );
        const todayPos = {};
        todaySorted.forEach((p, i) => { todayPos[p.puuid] = i + 1; });

        // Get the most recent rank_history entries from 45-75 minutes ago
        const t75 = new Date(Date.now() - 75 * 60 * 1000).toISOString();
        const t45 = new Date(Date.now() - 45 * 60 * 1000).toISOString();
        const { data: yesterday } = await supabase
          .from("rank_history")
          .select("puuid, score")
          .gte("recorded_at", t75)
          .lte("recorded_at", t45)
          .order("recorded_at", { ascending: false });

        if (!yesterday?.length) {
          // No yesterday data yet — return zeros
          return res.status(200).json(
            current.map(p => ({ puuid: p.puuid, delta: 0 }))
          );
        }

        // Latest entry per player from yesterday's window
        const yestByPuuid = {};
        for (const row of yesterday) {
          if (!yestByPuuid[row.puuid]) yestByPuuid[row.puuid] = row;
        }

        // Sort yesterday's scores → position yesterday
        const yestSorted = Object.values(yestByPuuid).sort((a, b) => b.score - a.score);
        const yestPos = {};
        yestSorted.forEach((p, i) => { yestPos[p.puuid] = i + 1; });

        const deltas = current.map(p => {
          const today = todayPos[p.puuid] ?? null;
          const yest  = yestPos[p.puuid]  ?? null;
          // delta > 0 means moved UP (lower position number = better)
          const delta = (today !== null && yest !== null) ? yest - today : null;
          return { puuid: p.puuid, delta };
        });

        return res.status(200).json(deltas);
      }

      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (e) {
    console.error("[data]", e.message);
    return res.status(500).json({ error: e.message });
  }
};