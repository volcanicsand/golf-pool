// U.S. Open Pool — live leaderboard from ESPN public feed

// Team names in draft order. Rosters are filled from the Draft panel (typed picks,
// saved in the browser) — see the Draft section at the bottom of this file.
const DEFAULT_TEAMS = ["Coz", "Tim", "TQ", "Sam", "John"];  // draft order (random roll)
const DRAFT_ROUNDS = 10;   // picks per team; lowest 5 count toward scoring
const DRAFT_KEY = "golfPoolDraft_usopen_2026";

// Once a draft is final, paste the exported block here and push — then the live
// site shows the same board to everyone (any viewer who hasn't drafted locally).
const PRESET_DRAFT = { teams: null, picks: [] };

let TEAMS = {};            // { teamName: [golfer, ...] } — rebuilt by applyDraft()
let TEAMS_ORDER = [];      // team names in draft order — set by applyDraft()
let TEAMS_COUNT = 0;       // set by applyDraft()

// Sportsbook win-only odds (American). Used as baseline prior; Polymarket overrides live.
const DRAFTKINGS_ODDS = {
  // Emptied for the U.S. Open. Paste current U.S. Open win odds (American) here to
  // restore the baseline prior; until then live Polymarket + draft-pick fallback supply it.
};

// Convert American odds to implied prob, normalize to remove vig
function americanToProb(odds) { return 100 / (odds + 100); }
const _dkRaw = Object.fromEntries(
  Object.entries(DRAFTKINGS_ODDS).map(([name, odds]) => [norm(name), americanToProb(odds)])
);
const _dkSum = Object.values(_dkRaw).reduce((s, p) => s + p, 0);
const DK_PROBS = Object.fromEntries(Object.entries(_dkRaw).map(([k, v]) => [k, v / _dkSum]));

const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const POLYMARKET_URL = "https://gamma-api.polymarket.com/markets";
const REFRESH_MS = 60000;

// ESPN's default scoreboard returns whatever event is "current" (e.g., the RBC
// Canadian Open the week before), so we query the U.S. Open dates and pick that
// event by name. U.S. Open 2026: June 18–21 (Shinnecock Hills).
const ESPN_EVENT_DATES = "20260618-20260622";
const TARGET_EVENT_RE = /u\.?\s*s\.?\s*open/i;

// TEAMS_ORDER / TEAMS_COUNT are derived from the draft (see applyDraft() below).

// Live Polymarket win probabilities, keyed by norm(playerName)
let polymarketOdds = {};
let polymarketUpdated = null;

function tryParseArray(val) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val) || []; } catch { return []; }
}

async function fetchPolymarketOdds() {
  const queries = [
    "U.S. Open 2026 winner",
    "US Open golf winner",
    "2026 U.S. Open golf",
  ];
  for (const q of queries) {
    try {
      const res = await fetch(`${POLYMARKET_URL}?keyword=${encodeURIComponent(q)}&active=true&limit=20`);
      if (!res.ok) continue;
      const markets = await res.json();

      // Find a winner-style market: mentions (U.S.) Open + win/champion + has many outcomes
      const candidates = markets.filter(m => {
        const title = (m.question || m.title || "").toLowerCase();
        return title.includes("open") && (title.includes("win") || title.includes("champion"));
      });
      candidates.sort((a, b) => tryParseArray(b.outcomes).length - tryParseArray(a.outcomes).length);

      if (!candidates.length) continue;
      const market = candidates[0];
      const outcomes = tryParseArray(market.outcomes);
      const prices = tryParseArray(market.outcomePrices);
      if (outcomes.length < 5) continue;

      const newOdds = {};
      for (let i = 0; i < outcomes.length; i++) {
        const prob = parseFloat(prices[i]) || 0;
        if (prob > 0) newOdds[norm(outcomes[i])] = prob;
      }
      polymarketOdds = newOdds;
      polymarketUpdated = new Date();
      updatePolymarketUI();
      return;
    } catch (e) {
      console.warn("Polymarket fetch failed for query:", q, e);
    }
  }
}

function updatePolymarketUI() {
  const el = document.getElementById("polymarket-updated");
  if (el) {
    el.textContent = polymarketUpdated
      ? `Polymarket odds: ${polymarketUpdated.toLocaleTimeString()}`
      : "Polymarket odds: unavailable (using sportsbook baseline)";
  }
}

// Snake-draft: round 1 forward (John→Tim), round 2 reverse, etc.
function getDraftPick(teamName, indexInTeam) {
  const teamIdx = TEAMS_ORDER.indexOf(teamName);
  const isReverse = (indexInTeam % 2 === 1);
  const positionInRound = isReverse ? (TEAMS_COUNT - 1 - teamIdx) : teamIdx;
  return indexInTeam * TEAMS_COUNT + positionInRound + 1;
}

// Prior win probability: Polymarket (live) → DraftKings (hardcoded baseline) → draft-pick fallback.
function priorWinProb(playerName, pick) {
  const key = norm(playerName);
  const poly = polymarketOdds[key];
  if (poly != null && poly > 0) return poly;
  const dk = DK_PROBS[key];
  if (dk != null && dk > 0) return dk;
  // Final fallback: draft-pick prior (pick 1 ≈ 18.18%, pick 2 ≈ 9.09%, pick 50 ≈ 0.91%)
  if (pick <= 1) return 0.1818;
  const k = Math.log(0.0909 / 0.0091) / 48;
  return 0.0909 * Math.exp(-k * (pick - 2));
}

// Per-hole scoring std dev ≈ 0.7 strokes. Variance of head-to-head difference is 2σ².
function liveLikelihood(score, leaderScore, missed, holesRemaining) {
  if (missed) return 0;
  if (score == null || leaderScore == null) return 1;
  const back = score - leaderScore;
  if (holesRemaining <= 0) return back === 0 ? 1 : 0;
  const sigma = 0.7 * Math.sqrt(Math.max(holesRemaining, 1));
  return Math.exp(-(back * back) / (4 * sigma * sigma));
}

function estimateHolesRemaining(period, statusDescription) {
  if (/final|completed|complete/i.test(statusDescription || "")) return 0;
  if (!period || period < 1) return 72;
  const completedRounds = Math.max(0, period - 1);
  const inProgress = (period >= 1 && period <= 4) ? 9 : 0;
  return Math.max(0, 72 - completedRounds * 18 - inProgress);
}

function computeWinProbs(allRows, leaderScore, holesRemaining) {
  for (const row of allRows) {
    row.prior = priorWinProb(row.name, row.draftPick);
    row.likelihood = liveLikelihood(row.score, leaderScore, row.missed, holesRemaining);
    row.rawWeight = row.prior * row.likelihood;
  }
  const total = allRows.reduce((s, r) => s + r.rawWeight, 0);
  for (const row of allRows) {
    row.winProb = total > 0 ? row.rawWeight / total : 0;
  }
}

// Box-Muller normal random
function randNormal(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Monte Carlo: simulate remaining tournament, apply pool scoring, count team wins.
// allRows must have .team annotated. Each non-missed player gets a sampled final score
// from N(currentScore + skill_adjustment, sigma); missed-cut players stay at the
// current cut penalty for ranking. After each sim, recompute Top 5 + bonuses per team
// and credit the winning team (1/N split on ties).
function simulatePoolWins(allRows, holesRemaining, cutPenalty) {
  const SIMS = 3000;
  const STROKE_SD_PER_ROUND = 3.0;
  const SKILL_SLOPE = 0.04;       // strokes per draft-pick per round; pick 25 = neutral
  const NEUTRAL_PICK = 25;
  const TOP_N = 5;
  const TOTAL_ROUNDS = 4;

  // --- Remaining-rounds rate model (regress current pace toward course baseline) ---
  // For each remaining round, expected to-par score is a blend of:
  //   - PACE_PERSISTENCE × current_pace  (how much current hot/cold form continues)
  //   - (1 − PACE_PERSISTENCE) × baseline  (course difficulty + pick-based skill)
  // PACE_PERSISTENCE: 0 = current pace ignored (full regression to baseline);
  //                   1 = current pace continues unchanged (hot/cold extrapolates fully).
  // COURSE_DIFFICULTY: expected per-round to-par average over remaining rounds for a
  //                    neutral (pick 25) player. 0 = course plays scratch; +0.5 to +1.0
  //                    typical for U.S. Open setups. Raise to dampen projections.
  const PACE_PERSISTENCE = 0.15;
  const COURSE_DIFFICULTY = 0.6;

  const teamWins = Object.fromEntries(TEAMS_ORDER.map(t => [t, 0]));
  const teamScoreHistory = Object.fromEntries(TEAMS_ORDER.map(t => [t, []]));

  // Handle the tournament-over case: deterministic winner based on current effective scores
  if (holesRemaining <= 0) {
    const teamAdj = Object.fromEntries(TEAMS_ORDER.map(t => [t, 0]));
    for (const t of TEAMS_ORDER) {
      const players = allRows.filter(r => r.team === t);
      const effs = players.map(r => r.effectiveScore).filter(x => x != null).sort((a, b) => a - b);
      const top5 = effs.slice(0, TOP_N).reduce((s, x) => s + x, 0);
      const bonus = players.reduce((s, r) => s + (r.bonus || 0), 0);
      teamAdj[t] = top5 + bonus;
    }
    const minAdj = Math.min(...Object.values(teamAdj));
    const winners = TEAMS_ORDER.filter(t => teamAdj[t] === minAdj);
    const winProbs = Object.fromEntries(TEAMS_ORDER.map(t => [t, 0]));
    for (const w of winners) winProbs[w] = 1 / winners.length;
    const projections = Object.fromEntries(TEAMS_ORDER.map(t => [t, {
      p25: teamAdj[t], median: teamAdj[t], p75: teamAdj[t]
    }]));
    return { winProbs, projections };
  }

  const roundsRemaining = holesRemaining / 18;
  const roundsPlayed = Math.max(0, TOTAL_ROUNDS - roundsRemaining);
  const sigma = STROKE_SD_PER_ROUND * Math.sqrt(roundsRemaining);

  // Pre-group by team for speed
  const teamPlayers = Object.fromEntries(TEAMS_ORDER.map(t => [t, allRows.filter(r => r.team === t)]));

  for (let s = 0; s < SIMS; s++) {
    // 1. Sample final score for each player.
    //    Future per-round rate blends current pace with a course/skill baseline.
    //    See PACE_PERSISTENCE / COURSE_DIFFICULTY at the top of this function.
    for (const r of allRows) {
      if (r.missed) {
        r._simFinal = null;       // ranked via cut penalty, not via score
      } else if (r.score == null) {
        r._simFinal = null;       // unknown; skip from leader/top-10 calc
      } else {
        const currentPace = roundsPlayed >= 0.5 ? r.score / roundsPlayed : 0;
        const skillRate = (r.draftPick - NEUTRAL_PICK) * SKILL_SLOPE;
        const baselineRate = COURSE_DIFFICULTY + skillRate;
        const futureRate = PACE_PERSISTENCE * currentPace + (1 - PACE_PERSISTENCE) * baselineRate;
        const expectedRemaining = futureRate * roundsRemaining;
        r._simFinal = r.score + expectedRemaining + randNormal(0, sigma);
      }
    }

    // 2. Cut penalty is fixed from the full ESPN field — missed players' fates are sealed
    const simCutPenalty = cutPenalty;

    // 3. Determine sim winner + sim top 10 (only among non-missed-cut players with a score)
    const playing = allRows.filter(r => !r.missed && r._simFinal != null);
    playing.sort((a, b) => a._simFinal - b._simFinal);
    const minFinal = playing.length > 0 ? playing[0]._simFinal : null;
    let pos = 1;
    for (let i = 0; i < playing.length; i++) {
      if (i > 0 && playing[i]._simFinal !== playing[i - 1]._simFinal) pos = i + 1;
      playing[i]._simPos = pos;
    }
    for (const r of allRows) {
      r._simIsWinner = !r.missed && r._simFinal != null && r._simFinal === minFinal;
      r._simIsTop10 = !r.missed && r._simFinal != null && r._simPos != null && r._simPos <= 10;
    }

    // 4. For each team: top 5 effective scores + bonuses
    let minAdj = Infinity;
    const teamAdj = {};
    for (const t of TEAMS_ORDER) {
      const players = teamPlayers[t];
      const effs = players.map(r => r.missed ? simCutPenalty : r._simFinal).filter(x => x != null).sort((a, b) => a - b);
      const top5 = effs.slice(0, TOP_N).reduce((sum, x) => sum + x, 0);
      let bonus = 0;
      for (const p of players) {
        if (p._simIsWinner) bonus -= 5;
        if (p._simIsTop10 && !p._simIsWinner) bonus -= 1;
      }
      const adj = top5 + bonus;
      teamAdj[t] = adj;
      if (adj < minAdj) minAdj = adj;
    }
    const winners = TEAMS_ORDER.filter(t => teamAdj[t] === minAdj);
    for (const w of winners) teamWins[w] += 1 / winners.length;
    for (const t of TEAMS_ORDER) teamScoreHistory[t].push(teamAdj[t]);
  }

  const winProbs = {};
  const projections = {};
  for (const t of TEAMS_ORDER) {
    winProbs[t] = teamWins[t] / SIMS;
    const sorted = teamScoreHistory[t].slice().sort((a, b) => a - b);
    projections[t] = {
      p25:    sorted[Math.floor(SIMS * 0.25)],
      median: sorted[Math.floor(SIMS * 0.50)],
      p75:    sorted[Math.floor(SIMS * 0.75)],
    };
  }
  return { winProbs, projections };
}

// Normalize for matching: lowercase, strip diacritics + non-decomposable letters, drop punctuation
function norm(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Non-decomposable special letters that NFD doesn't split
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe")
    .replace(/[ðÐ]/g, "d")
    .replace(/[þÞ]/g, "th")
    .replace(/[ßẞ]/g, "ss")
    .replace(/[łŁ]/g, "l")
    .toLowerCase()
    .replace(/[.'\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseScore(s) {
  if (s === "E" || s === "" || s == null) return 0;
  if (s === "CUT" || s === "WD" || s === "DQ") return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function fmtScore(n) {
  if (n == null) return "—";
  const r = Math.round(n * 10) / 10; // max 1 decimal place
  if (r === 0) return "E";
  const s = r % 1 === 0 ? String(r) : r.toFixed(1);
  return r > 0 ? `+${s}` : s;
}

function scoreClass(n) {
  if (n == null) return "";
  if (n < 0) return "under";
  if (n > 0) return "over";
  return "";
}

async function fetchData() {
  const res = await fetch(`${ESPN_URL}?dates=${ESPN_EVENT_DATES}&_=${Date.now()}`);
  if (!res.ok) throw new Error("ESPN fetch failed: " + res.status);
  return await res.json();
}

function buildPlayerIndex(competitors) {
  // Compute positions client-side from current scores so we don't depend on
  // ESPN populating position.displayName (which isn't always set during play).
  // Players with a missed-cut/WD/DQ status are excluded from position ranking.
  // Fallback: if ESPN doesn't provide status, detect cut via linescores count —
  // players with fewer rounds of data than the max have missed the cut.
  const maxRounds = Math.max(...competitors.map(p => (p.linescores || []).length), 0);
  const active = [];
  const sidelined = [];
  for (const p of competitors) {
    const status = p.status?.type?.description || "";
    const rounds = (p.linescores || []).length;
    if (/cut|wd|dq/i.test(status) || (maxRounds > 2 && rounds < maxRounds)) {
      sidelined.push(p);
    } else {
      active.push(p);
    }
  }
  // Sort active by parsed score ascending; players without a score sort last
  active.sort((a, b) => {
    const sa = parseScore(a.score);
    const sb = parseScore(b.score);
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sa - sb;
  });
  // Assign positions with tie handling
  const posMap = new Map();
  let i = 0;
  while (i < active.length) {
    const score = parseScore(active[i].score);
    if (score == null) {
      posMap.set(active[i].athlete?.displayName, { num: null, label: "—" });
      i++;
      continue;
    }
    let j = i;
    while (j < active.length && parseScore(active[j].score) === score) j++;
    const tied = j - i > 1;
    for (let k = i; k < j; k++) {
      posMap.set(active[k].athlete?.displayName, { num: i + 1, label: (tied ? "T" : "") + (i + 1) });
    }
    i = j;
  }
  for (const p of sidelined) {
    posMap.set(p.athlete?.displayName, { num: null, label: "CUT" });
  }

  const sidelinedNames = new Set(sidelined.map(p => p.athlete?.displayName));
  const idx = new Map();
  for (const p of competitors) {
    const name = p.athlete?.displayName || "";
    const espnPos = p.status?.position?.displayName || "";
    const computed = posMap.get(name) || { num: null, label: "" };
    idx.set(norm(name), {
      name,
      score: p.score,
      pos: espnPos || computed.label,
      posNum: computed.num,
      thru: p.status?.thru || "",
      status: p.status?.type?.description || "",
      missed: sidelinedNames.has(name),
    });
  }
  return idx;
}

function positionNumber(posStr) {
  if (!posStr) return null;
  if (/cut|wd|dq/i.test(posStr)) return null;
  const m = posStr.match(/T?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function render(data) {
  const ev = (data.events || []).find(e => TARGET_EVENT_RE.test(e.name || "")) || data.events?.[0];
  if (!ev) {
    document.getElementById("event").textContent = "No active event";
    return;
  }
  const comp = ev.competitions?.[0] || {};
  const players = comp.competitors || [];
  const idx = buildPlayerIndex(players);

  // Feed the draft autocomplete with the live field
  populateFieldDatalist(idx);

  // Header
  document.getElementById("event").textContent = ev.name || "";
  document.getElementById("status").textContent = ev.status?.type?.description || "";
  const round = ev.status?.period ? `Round ${ev.status.period}` : "";
  document.getElementById("round").textContent = round;
  document.getElementById("updated").textContent = new Date().toLocaleTimeString();
  updatePolymarketUI();

  // Build team scores — top 5 counts toward official ranking, all 10 tracked
  // Missed-cut players are assigned the worst score among players who made cut
  // (only matters once cut is made; before cut, no one is in CUT status so penalty = 0 effectively)
  const TOP_N = 5;

  // Compute cut penalty: worst (highest) score among players who did NOT miss cut
  const fieldPlayers = [...idx.values()];
  const madeCutScores = fieldPlayers
    .filter(p => !p.missed)
    .map(p => parseScore(p.score))
    .filter(s => s != null);
  const cutPenalty = madeCutScores.length > 0 ? Math.max(...madeCutScores) : 0;
  const anyCutsMade = fieldPlayers.some(p => p.missed);

  // Count co-leaders in the full field so the winner bonus splits evenly among tied leaders
  const leadersCount = Math.max(1, fieldPlayers.filter(p => {
    const pn = p.posNum != null ? p.posNum : positionNumber(p.pos);
    return pn === 1;
  }).length);
  const winnerBonus = 5 / leadersCount;

  const teamScores = [];
  const warnings = [];

  for (const [team, roster] of Object.entries(TEAMS)) {
    const rows = [];
    for (let pickIdx = 0; pickIdx < roster.length; pickIdx++) {
      const pname = roster[pickIdx];
      const draftPick = getDraftPick(team, pickIdx);
      const p = idx.get(norm(pname));
      if (!p) {
        warnings.push(`Could not find player "${pname}" for ${team}`);
        rows.push({ name: pname, score: null, effectiveScore: null, missed: false, missing: true, counts: false, penalized: false, posNum: null, bonus: 0, draftPick });
        continue;
      }
      const score = parseScore(p.score);
      const missed = p.missed;
      const effectiveScore = missed && score != null ? cutPenalty : score;
      const penalized = missed && score != null && effectiveScore !== score;
      const posNum = p.posNum != null ? p.posNum : positionNumber(p.pos);
      const isWinner = posNum === 1;
      const isTop10 = posNum != null && posNum <= 10;
      // Bonuses: -5/x for co-leaders (x = tied at #1); -1 for top 10 but NOT the winner (no stacking). Sole leader gets -5.
      let bonus = 0;
      if (isWinner) bonus -= winnerBonus;
      if (isTop10 && !isWinner) bonus -= 1;
      rows.push({
        name: p.name,
        rawScore: p.score,
        score,
        effectiveScore,
        thru: p.thru,
        pos: p.pos,
        posNum,
        missed,
        penalized,
        isWinner,
        isTop10,
        bonus,
        counts: false,
        draftPick,
      });
    }

    // Top 5 lowest effective scores count
    const playersWithScore = rows.filter(r => r.effectiveScore != null);
    playersWithScore.sort((a, b) => a.effectiveScore - b.effectiveScore);
    playersWithScore.slice(0, TOP_N).forEach(r => { r.counts = true; });

    const top5Total = playersWithScore.slice(0, TOP_N).reduce((s, r) => s + r.effectiveScore, 0);
    const livePlayers = rows.filter(r => r.score != null && !r.missed);
    const allTotal = livePlayers.reduce((s, r) => s + r.score, 0);
    const liveCount = livePlayers.length;
    // Bonus applies based on ALL team players' positions (not just top 5)
    const totalBonus = rows.reduce((s, r) => s + (r.bonus || 0), 0);
    const adjustedTotal = top5Total + totalBonus;

    teamScores.push({ team, top5Total, allTotal, liveCount, totalBonus, adjustedTotal, rows });
  }

  // Sort by top 5 raw ascending; tiebreak on adjusted, then all 10
  teamScores.sort((a, b) =>
    a.top5Total - b.top5Total ||
    a.adjustedTotal - b.adjustedTotal ||
    a.allTotal - b.allTotal
  );
  window._cutPenalty = cutPenalty;
  window._anyCutsMade = anyCutsMade;

  // Per-player tournament-win probability (informational, shown on cards)
  const leaderScore = madeCutScores.length > 0 ? Math.min(...madeCutScores) : null;
  const holesRemaining = estimateHolesRemaining(ev.status?.period, ev.status?.type?.description);
  const allRows = [];
  for (const t of teamScores) {
    for (const r of t.rows) {
      r.team = t.team;
      allRows.push(r);
    }
  }
  computeWinProbs(allRows, leaderScore, holesRemaining);

  // Pool-win probability + final score projections: Monte Carlo simulation
  const { winProbs: poolProbs, projections: teamProjections } = simulatePoolWins(allRows, holesRemaining, cutPenalty);
  for (const t of teamScores) {
    t.poolProb = poolProbs[t.team] || 0;
    t.projection = teamProjections[t.team];
  }

  // Render leaderboard — official = adjusted (top 5 + bonuses); show raw top-5 and all-10 alongside
  const fmtBonus = n => n % 1 === 0 ? String(n) : n.toFixed(1);
  const tbody = document.querySelector("#teams tbody");
  tbody.innerHTML = "";
  teamScores.forEach((t, i) => {
    const tr = document.createElement("tr");
    const bonusDisp = t.totalBonus === 0 ? "—" : (t.totalBonus > 0 ? `+${fmtBonus(t.totalBonus)}` : fmtBonus(t.totalBonus));
    const poolPct = t.poolProb != null ? (t.poolProb * 100).toFixed(1) + "%" : "—";
    const proj = t.projection;
    let projDisp = "—";
    if (proj) {
      const med = Math.round(proj.median);
      const lo  = Math.round(proj.p25);
      const hi  = Math.round(proj.p75);
      projDisp = `<span class="${scoreClass(med)}">${fmtScore(med)}</span> <span class="proj-range">(${fmtScore(lo)}–${fmtScore(hi)})</span>`;
    }
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${t.team}</td>
      <td class="num lead-total ${scoreClass(t.top5Total)}">${fmtScore(t.top5Total)}</td>
      <td class="num ${scoreClass(t.adjustedTotal)}">${fmtScore(t.adjustedTotal)}</td>
      <td class="num bonus ${t.totalBonus < 0 ? 'under' : ''}">${bonusDisp}</td>
      <td class="num all-total ${scoreClass(t.allTotal)}">${fmtScore(t.allTotal)} (${t.liveCount})</td>
      <td class="num proj">${projDisp}</td>
      <td class="num pool-prob">${poolPct}</td>
    `;
    tbody.appendChild(tr);
  });

  // Render team cards in standings order
  const cards = document.getElementById("team-cards");
  cards.innerHTML = "";
  teamScores.forEach((t) => {
    const card = document.createElement("div");
    card.className = "card";
    const playerRows = t.rows
      .slice()
      .sort((a, b) => (a.effectiveScore ?? 99) - (b.effectiveScore ?? 99))
      .map(r => {
        if (r.missing) {
          return `<li class="not-found"><span class="nm">${r.name}</span><span class="sc">N/A</span></li>`;
        }
        const cls = scoreClass(r.score);
        const display = r.score == null ? (r.rawScore || "—") : fmtScore(r.score);
        const thru = r.thru ? ` <span class="thru">thru ${r.thru}</span>` : "";
        const pos = (r.pos && !r.missed) ? ` <span class="pos">${r.pos}</span>` : "";
        const classes = [];
        if (r.missed) classes.push("missed-cut");
        if (r.counts) classes.push("counts");
        if (r.penalized) classes.push("penalized");
        const star = r.counts ? '<span class="star" title="Counts toward top 5">★</span> ' : '<span class="star-spacer">  </span>';
        const penaltyNote = r.penalized ? ` <span class="penalty-note">→ ${fmtScore(r.effectiveScore)}</span>` : "";
        const bonusTags = [];
        if (r.isWinner) {
          const wbStr = winnerBonus % 1 === 0 ? winnerBonus.toFixed(0) : winnerBonus.toFixed(1);
          const label = leadersCount > 1 ? `WIN −${wbStr} (T${leadersCount})` : `WIN −5`;
          bonusTags.push(`<span class="bonus-tag" title="-5 split ${leadersCount} ways">${label}</span>`);
        } else if (r.isTop10) bonusTags.push('<span class="bonus-tag" title="-1 top 10">T10 −1</span>');
        return `<li class="${classes.join(' ')}">${star}<span class="nm">${r.name}${pos}${thru}</span><span class="sc ${cls}">${display}${penaltyNote}${bonusTags.join('')}</span></li>`;
      })
      .join("");
    const bonusDispC = t.totalBonus === 0 ? "" : ` <span class="bonus-inline">${t.totalBonus > 0 ? '+' : ''}${fmtBonus(t.totalBonus)} bonus</span>`;
    card.innerHTML = `
      <h3>${t.team} <span class="tot ${scoreClass(t.top5Total)}">${fmtScore(t.top5Total)}</span></h3>
      <div class="subtitle">top 5 · adjusted: <span class="${scoreClass(t.adjustedTotal)}">${fmtScore(t.adjustedTotal)}</span>${bonusDispC} · live: <span class="${scoreClass(t.allTotal)}">${fmtScore(t.allTotal)}</span> (${t.liveCount})</div>
      <ul>${playerRows}</ul>
    `;
    cards.appendChild(card);
  });

  // Warnings (if any unmatched names)
  const warnSection = document.getElementById("warnings");
  const warnList = document.getElementById("warn-list");
  if (warnings.length > 0) {
    warnSection.hidden = false;
    warnList.innerHTML = warnings.map(w => `<li>${w}</li>`).join("");
  } else {
    warnSection.hidden = true;
  }
}

async function refresh() {
  try {
    const data = await fetchData();
    window._lastData = data;
    render(data);
  } catch (e) {
    console.error(e);
    document.getElementById("event").textContent = "Fetch error — see console";
  }
}

/* ============================ Draft entry ============================ */
// Picks are typed into the grid in snake order and saved to the browser.
// applyDraft() turns them into TEAMS / TEAMS_ORDER / TEAMS_COUNT, which the
// leaderboard already knows how to score.

let draft = loadDraft();

function loadDraft() {
  try {
    const s = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (s && Array.isArray(s.teams) && Array.isArray(s.picks)) {
      return { teams: s.teams.slice(), rounds: s.rounds || DRAFT_ROUNDS, picks: s.picks.slice() };
    }
  } catch {}
  // No local draft → use the published (code-baked) draft if one exists, so every
  // visitor sees the same board (this is how the old hardcoded rosters worked).
  if (PRESET_DRAFT && Array.isArray(PRESET_DRAFT.picks) && PRESET_DRAFT.picks.some(p => p && p.trim())) {
    return { teams: (PRESET_DRAFT.teams || DEFAULT_TEAMS).slice(), rounds: DRAFT_ROUNDS, picks: PRESET_DRAFT.picks.slice() };
  }
  return { teams: DEFAULT_TEAMS.slice(), rounds: DRAFT_ROUNDS, picks: [] };
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
}

const totalPicks = () => draft.teams.length * draft.rounds;

// Flat snake index for the cell at (round r, column c). Mirrors getDraftPick():
// round 0 runs left→right, round 1 right→left, and so on.
function pickIndex(r, c) {
  const n = draft.teams.length;
  const posInRound = (r % 2 === 0) ? c : (n - 1 - c);
  return r * n + posInRound;
}

// Rebuild TEAMS / TEAMS_ORDER / TEAMS_COUNT from the typed picks.
function applyDraft() {
  TEAMS_ORDER = draft.teams.slice();
  TEAMS_COUNT = TEAMS_ORDER.length;
  TEAMS = {};
  for (const t of draft.teams) TEAMS[t] = [];
  for (let r = 0; r < draft.rounds; r++) {
    for (let c = 0; c < draft.teams.length; c++) {
      const name = (draft.picks[pickIndex(r, c)] || "").trim();
      if (name) TEAMS[draft.teams[c]].push(name);
    }
  }
}

function escHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function populateFieldDatalist(idx) {
  const dl = document.getElementById("field-names");
  if (!dl) return;
  const names = [...idx.values()].map(p => p.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  dl.innerHTML = names.map(n => `<option value="${escAttr(n)}"></option>`).join("");
}

// Re-render the leaderboard from the last ESPN payload (no refetch needed)
function renderFromCache() {
  if (window._lastData) { try { render(window._lastData); } catch (e) { console.error(e); } }
}

function renderDraft(focusNext) {
  const board = document.getElementById("draft-board");
  if (!board) return;
  const n = draft.teams.length;

  // next empty slot, scanned in snake order = "on the clock"
  let nextIdx = -1;
  for (let i = 0; i < totalPicks(); i++) {
    if (!(draft.picks[i] || "").trim()) { nextIdx = i; break; }
  }

  let html = "<table class='draft-table'><thead><tr><th></th>";
  for (let c = 0; c < n; c++) {
    html += `<th><input class="team-name" data-col="${c}" value="${escAttr(draft.teams[c])}" aria-label="Team ${c + 1} name"></th>`;
  }
  html += "</tr></thead><tbody>";
  for (let r = 0; r < draft.rounds; r++) {
    html += `<tr><td class="rnd">R${r + 1}</td>`;
    for (let c = 0; c < n; c++) {
      const idx = pickIndex(r, c);
      const isNext = idx === nextIdx;
      html += `<td><input class="pick${isNext ? " next" : ""}" list="field-names" data-idx="${idx}" value="${escAttr(draft.picks[idx] || "")}" placeholder="${isNext ? "on the clock" : ""}" aria-label="Round ${r + 1} ${escAttr(draft.teams[c])}"></td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  board.innerHTML = html;

  const oc = document.getElementById("draft-onclock");
  if (oc) {
    if (nextIdx === -1) {
      oc.innerHTML = `All ${totalPicks()} picks entered — edit any cell to adjust. Rosters update below as you type.`;
    } else {
      const r = Math.floor(nextIdx / n);
      const posInRound = nextIdx - r * n;
      const c = (r % 2 === 0) ? posInRound : (n - 1 - posInRound);
      oc.innerHTML = `Pick <strong>${nextIdx + 1}</strong> of ${totalPicks()} · Round ${r + 1} · <strong>${escHtml(draft.teams[c])}</strong> on the clock`;
    }
  }

  board.querySelectorAll("input.pick").forEach(inp => {
    inp.addEventListener("change", () => {
      const idx = parseInt(inp.dataset.idx, 10);
      draft.picks[idx] = inp.value.trim();
      while (draft.picks.length && !(draft.picks[draft.picks.length - 1] || "").trim()) draft.picks.pop();
      saveDraft(); applyDraft(); renderFromCache(); renderDraft(true);
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
  });
  board.querySelectorAll("input.team-name").forEach(inp => {
    inp.addEventListener("change", () => {
      const c = parseInt(inp.dataset.col, 10);
      draft.teams[c] = inp.value.trim() || draft.teams[c];
      saveDraft(); applyDraft(); renderFromCache(); renderDraft();
    });
  });

  if (focusNext) { const nx = board.querySelector("input.pick.next"); if (nx) nx.focus(); }
}

function initDraft() {
  applyDraft();
  const undo = document.getElementById("draft-undo");
  if (undo) undo.addEventListener("click", () => {
    let last = -1;
    for (let i = 0; i < totalPicks(); i++) if ((draft.picks[i] || "").trim()) last = i;
    if (last >= 0) {
      draft.picks[last] = "";
      while (draft.picks.length && !(draft.picks[draft.picks.length - 1] || "").trim()) draft.picks.pop();
      saveDraft(); applyDraft(); renderFromCache(); renderDraft(true);
    }
  });
  const clear = document.getElementById("draft-clear");
  if (clear) clear.addEventListener("click", () => {
    if (!confirm("Clear all picks and reset team names? This cannot be undone.")) return;
    draft = { teams: DEFAULT_TEAMS.slice(), rounds: DRAFT_ROUNDS, picks: [] };
    saveDraft(); applyDraft(); renderFromCache(); renderDraft(true);
  });
  const exportBtn = document.getElementById("draft-export");
  if (exportBtn) exportBtn.addEventListener("click", () => {
    const rosters = draft.teams.map((t, c) => {
      const ps = [];
      for (let r = 0; r < draft.rounds; r++) {
        const p = (draft.picks[pickIndex(r, c)] || "").trim();
        if (p) ps.push(p);
      }
      return `${t}: ${ps.join(", ")}`;
    }).join("\n");
    const block = `const PRESET_DRAFT = ${JSON.stringify({ teams: draft.teams, picks: draft.picks })};`;
    const text = rosters + "\n\n--- paste this whole message to publish for everyone ---\n" + block;
    const out = document.getElementById("draft-export-out");
    if (out) { out.hidden = false; out.value = text; out.focus(); out.select(); }
    try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch {}
  });
  renderDraft();
}

/* ============================ Kickoff ============================ */
initDraft();                              // build rosters + draft UI from saved picks
Promise.all([fetchPolymarketOdds(), refresh()]);
setInterval(() => { fetchPolymarketOdds(); refresh(); }, REFRESH_MS);
