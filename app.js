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
    for (const pname of roster) {
      const p = idx.get(norm(pname));
      if (!p) {
        warnings.push(`Could not find player "${pname}" for ${team}`);
        rows.push({ name: pname, score: null, effectiveScore: null, missed: false, missing: true, counts: false, penalized: false, posNum: null, bonus: 0 });
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

  // Render leaderboard — official = adjusted (top 5 + bonuses); show raw top-5 and all-10 alongside
  const tbody = document.querySelector("#teams tbody");
  tbody.innerHTML = "";
  teamScores.forEach((t, i) => {
    const tr = document.createElement("tr");
    const bonusDisp = t.totalBonus === 0 ? "—" : (t.totalBonus > 0 ? `+${t.totalBonus}` : `${t.totalBonus}`);
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${t.team}</td>
      <td class="num lead-total ${scoreClass(t.top5Total)}">${fmtScore(t.top5Total)}</td>
      <td class="num ${scoreClass(t.adjustedTotal)}">${fmtScore(t.adjustedTotal)}</td>
      <td class="num bonus ${t.totalBonus < 0 ? 'under' : ''}">${bonusDisp}</td>
      <td class="num all-total ${scoreClass(t.allTotal)}">${fmtScore(t.allTotal)}</td>
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
