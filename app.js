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

// Normalize for matching: lowercase, strip diacritics, drop punctuation, collapse spaces
function norm(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
  const idx = new Map();
  for (const p of competitors) {
    const name = p.athlete?.displayName || "";
    idx.set(norm(name), {
      name,
      score: p.score,
      pos: p.status?.position?.displayName || "",
      thru: p.status?.thru || "",
      status: p.status?.type?.description || "",
    });
  }
  return idx;
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

  // Build team scores
  const teamScores = [];
  const warnings = [];

  for (const [team, roster] of Object.entries(TEAMS)) {
    const rows = [];
    let total = 0;
    let counted = 0;
    for (const pname of roster) {
      const p = idx.get(norm(pname));
      if (!p) {
        warnings.push(`Could not find player "${pname}" for ${team}`);
        rows.push({ name: pname, score: null, missed: false, missing: true });
        continue;
      }
      const score = parseScore(p.score);
      const missed = score === null && /cut|wd|dq/i.test(p.score || p.status);
      // For missed cut, count as their last score at cut line (which is what their "score" field still reflects)
      // ESPN often keeps the cut player's score even after CUT, but if it returns null we skip.
      if (score != null) {
        total += score;
        counted++;
      }
      rows.push({
        name: p.name,
        rawScore: p.score,
        score,
        thru: p.thru,
        missed: /cut|wd|dq/i.test(p.status || ""),
      });
    }
    teamScores.push({ team, total, counted, rows });
  }

  // Sort by total ascending (lower is better in golf)
  teamScores.sort((a, b) => a.total - b.total);

  // Render leaderboard
  const tbody = document.querySelector("#teams tbody");
  tbody.innerHTML = "";
  teamScores.forEach((t, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${t.team}</td>
      <td class="num ${scoreClass(t.total)}">${fmtScore(t.total)}</td>
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
      .sort((a, b) => (a.score ?? 99) - (b.score ?? 99))
      .map(r => {
        if (r.missing) {
          return `<li class="missed"><span class="nm">${r.name}</span><span class="sc">N/A</span></li>`;
        }
        const cls = scoreClass(r.score);
        const display = r.score == null ? (r.rawScore || "—") : fmtScore(r.score);
        const thru = r.thru ? ` <span style="color: var(--muted); font-size: 11px;">thru ${r.thru}</span>` : "";
        const missedCls = r.missed ? "missed" : "";
        return `<li class="${missedCls}"><span class="nm">${r.name}${thru}</span><span class="sc ${cls}">${display}</span></li>`;
      })
      .join("");
    card.innerHTML = `
      <h3>${t.team} <span class="tot ${scoreClass(t.total)}">${fmtScore(t.total)}</span></h3>
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
