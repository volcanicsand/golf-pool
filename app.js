// PGA Championship Pool — live leaderboard from ESPN public feed

const TEAMS = {
  "John": ["Scottie Scheffler","Tommy Fleetwood","Collin Morikawa","Min Woo Lee","Si Woo Kim","Nicolai Hojgaard","Hideki Matsuyama","Maverick McNealy","Kurt Kitayama","David Puig"],
  "TQ":   ["Cameron Young","Brooks Koepka","Patrick Cantlay","Chris Gotterup","Adam Scott","J.J. Spaun","Alex Fitzpatrick","Shane Lowry","Gary Woodland","Keegan Bradley"],
  "Sam":  ["Rory McIlroy","Ludvig Aberg","Tyrrell Hatton","Viktor Hovland","Patrick Reed","Harris English","Corey Conners","Matt McCarty","Jason Day","Alex Smalley"],
  "Coz":  ["Jon Rahm","Xander Schauffele","Russell Henley","Rickie Fowler","Sam Burns","Robert MacIntyre","Sepp Straka","Ben Griffin","Thomas Detry","Wyndham Clark"],
  "Tim":  ["Matt Fitzpatrick","Bryson DeChambeau","Justin Thomas","Justin Rose","Jordan Spieth","Kristoffer Reitan","Akshay Bhatia","Michael Thorbjornsen","Joaquin Niemann","Sungjae Im"],
};

const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const REFRESH_MS = 60000;

const TEAMS_ORDER = Object.keys(TEAMS);
const TEAMS_COUNT = TEAMS_ORDER.length;

// Snake-draft: round 1 forward (John→Tim), round 2 reverse, etc.
function getDraftPick(teamName, indexInTeam) {
  const teamIdx = TEAMS_ORDER.indexOf(teamName);
  const isReverse = (indexInTeam % 2 === 1);
  const positionInRound = isReverse ? (TEAMS_COUNT - 1 - teamIdx) : teamIdx;
  return indexInTeam * TEAMS_COUNT + positionInRound + 1;
}

// Pre-tournament prior anchored to: pick 1 ≈ +450 (18.18%); pick 2 ≈ +1000 (9.09%); pick 50 ≈ +10000 (0.91%).
function priorWinProb(pick) {
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
    row.prior = priorWinProb(row.draftPick);
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

  const teamWins = Object.fromEntries(TEAMS_ORDER.map(t => [t, 0]));

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
    const out = Object.fromEntries(TEAMS_ORDER.map(t => [t, 0]));
    for (const w of winners) out[w] = 1 / winners.length;
    return out;
  }

  const roundsRemaining = holesRemaining / 18;
  const sigma = STROKE_SD_PER_ROUND * Math.sqrt(roundsRemaining);

  // Pre-group by team for speed
  const teamPlayers = Object.fromEntries(TEAMS_ORDER.map(t => [t, allRows.filter(r => r.team === t)]));

  for (let s = 0; s < SIMS; s++) {
    // 1. Sample final score for each player
    for (const r of allRows) {
      if (r.missed) {
        r._simFinal = null;       // ranked via cut penalty, not via score
      } else if (r.score == null) {
        r._simFinal = null;       // unknown; skip from leader/top-10 calc
      } else {
        const skillAdj = (r.draftPick - NEUTRAL_PICK) * SKILL_SLOPE * roundsRemaining;
        r._simFinal = r.score + skillAdj + randNormal(0, sigma);
      }
    }

    // 2. Recompute cut penalty for this sim = max of made-cut sim finals
    const madeFinals = allRows.filter(r => !r.missed && r._simFinal != null).map(r => r._simFinal);
    const simCutPenalty = madeFinals.length > 0 ? Math.max(...madeFinals) : cutPenalty;

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
        if (p._simIsTop10) bonus -= 1;
      }
      const adj = top5 + bonus;
      teamAdj[t] = adj;
      if (adj < minAdj) minAdj = adj;
    }
    const winners = TEAMS_ORDER.filter(t => teamAdj[t] === minAdj);
    for (const w of winners) teamWins[w] += 1 / winners.length;
  }

  const out = {};
  for (const t of TEAMS_ORDER) out[t] = teamWins[t] / SIMS;
  return out;
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
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function scoreClass(n) {
  if (n == null) return "";
  if (n < 0) return "under";
  if (n > 0) return "over";
  return "";
}

async function fetchData() {
  const res = await fetch(ESPN_URL + "?_=" + Date.now());
  if (!res.ok) throw new Error("ESPN fetch failed: " + res.status);
  return await res.json();
}

function buildPlayerIndex(competitors) {
  // Compute positions client-side from current scores so we don't depend on
  // ESPN populating position.displayName (which isn't always set during play).
  // Players with a missed-cut/WD/DQ status are excluded from position ranking.
  const active = [];
  const sidelined = [];
  for (const p of competitors) {
    const status = p.status?.type?.description || "";
    if (/cut|wd|dq/i.test(status)) {
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
  const ev = data.events?.[0];
  if (!ev) {
    document.getElementById("event").textContent = "No active event";
    return;
  }
  const comp = ev.competitions?.[0] || {};
  const players = comp.competitors || [];
  const idx = buildPlayerIndex(players);

  // Header
  document.getElementById("event").textContent = ev.name || "";
  document.getElementById("status").textContent = ev.status?.type?.description || "";
  const round = ev.status?.period ? `Round ${ev.status.period}` : "";
  document.getElementById("round").textContent = round;
  document.getElementById("updated").textContent = new Date().toLocaleTimeString();

  // Build team scores — top 5 counts toward official ranking, all 10 tracked
  // Missed-cut players are assigned the worst score among players who made cut
  // (only matters once cut is made; before cut, no one is in CUT status so penalty = 0 effectively)
  const TOP_N = 5;

  // Compute cut penalty: worst (highest) score among players who did NOT miss cut
  const fieldPlayers = [...idx.values()];
  const madeCutScores = fieldPlayers
    .filter(p => !/cut|wd|dq/i.test(p.status || ""))
    .map(p => parseScore(p.score))
    .filter(s => s != null);
  const cutPenalty = madeCutScores.length > 0 ? Math.max(...madeCutScores) : 0;
  const anyCutsMade = fieldPlayers.some(p => /cut|wd|dq/i.test(p.status || ""));

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
      const missed = /cut|wd|dq/i.test(p.status || "");
      const effectiveScore = missed && score != null ? cutPenalty : score;
      const penalized = missed && score != null && effectiveScore !== score;
      const posNum = p.posNum != null ? p.posNum : positionNumber(p.pos);
      const isWinner = posNum === 1;
      const isTop10 = posNum != null && posNum <= 10;
      // Bonuses: -5 for winner (T1 counts), -1 for top 10 (T1-T10). Winner also gets top-10 bonus (stacked: -6).
      let bonus = 0;
      if (isWinner) bonus -= 5;
      if (isTop10) bonus -= 1;
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
    const allTotal = rows.filter(r => r.score != null).reduce((s, r) => s + r.score, 0);
    // Bonus applies based on ALL team players' positions (not just top 5)
    const totalBonus = rows.reduce((s, r) => s + (r.bonus || 0), 0);
    const adjustedTotal = top5Total + totalBonus;

    teamScores.push({ team, top5Total, allTotal, totalBonus, adjustedTotal, rows });
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

  // Pool-win probability: Monte Carlo simulation of remaining tournament + scoring rules
  const poolProbs = simulatePoolWins(allRows, holesRemaining, cutPenalty);
  for (const t of teamScores) {
    t.poolProb = poolProbs[t.team] || 0;
  }

  // Render leaderboard — official = adjusted (top 5 + bonuses); show raw top-5 and all-10 alongside
  const tbody = document.querySelector("#teams tbody");
  tbody.innerHTML = "";
  teamScores.forEach((t, i) => {
    const tr = document.createElement("tr");
    const bonusDisp = t.totalBonus === 0 ? "—" : (t.totalBonus > 0 ? `+${t.totalBonus}` : `${t.totalBonus}`);
    const poolPct = t.poolProb != null ? (t.poolProb * 100).toFixed(1) + "%" : "—";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${t.team}</td>
      <td class="num lead-total ${scoreClass(t.top5Total)}">${fmtScore(t.top5Total)}</td>
      <td class="num ${scoreClass(t.adjustedTotal)}">${fmtScore(t.adjustedTotal)}</td>
      <td class="num bonus ${t.totalBonus < 0 ? 'under' : ''}">${bonusDisp}</td>
      <td class="num all-total ${scoreClass(t.allTotal)}">${fmtScore(t.allTotal)}</td>
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
        const pos = r.pos ? ` <span class="pos">${r.pos}</span>` : "";
        const classes = [];
        if (r.missed) classes.push("missed-cut");
        if (r.counts) classes.push("counts");
        if (r.penalized) classes.push("penalized");
        const star = r.counts ? '<span class="star" title="Counts toward top 5">★</span> ' : '<span class="star-spacer">  </span>';
        const penaltyNote = r.penalized ? ` <span class="penalty-note">→ ${fmtScore(r.effectiveScore)}</span>` : "";
        const bonusTags = [];
        if (r.isWinner) bonusTags.push('<span class="bonus-tag" title="-5 winner">WIN −5</span>');
        else if (r.isTop10) bonusTags.push('<span class="bonus-tag" title="-1 top 10">T10 −1</span>');
        return `<li class="${classes.join(' ')}">${star}<span class="nm">${r.name}${pos}${thru}</span><span class="sc ${cls}">${display}${penaltyNote}${bonusTags.join('')}</span></li>`;
      })
      .join("");
    const bonusDispC = t.totalBonus === 0 ? "" : ` <span class="bonus-inline">${t.totalBonus > 0 ? '+' : ''}${t.totalBonus} bonus</span>`;
    card.innerHTML = `
      <h3>${t.team} <span class="tot ${scoreClass(t.top5Total)}">${fmtScore(t.top5Total)}</span></h3>
      <div class="subtitle">top 5 · adjusted: <span class="${scoreClass(t.adjustedTotal)}">${fmtScore(t.adjustedTotal)}</span>${bonusDispC} · all 10: <span class="${scoreClass(t.allTotal)}">${fmtScore(t.allTotal)}</span></div>
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
    render(data);
  } catch (e) {
    console.error(e);
    document.getElementById("event").textContent = "Fetch error — see console";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
