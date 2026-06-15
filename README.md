# U.S. Open Pool — live tracker

Static HTML page that pulls live U.S. Open scoring from ESPN's public feed and aggregates by team for our pool.

## Pool structure

5 teams (John, TQ, Sam, Coz, Tim), 10 players each. Combined to-par score is the team total — lower is better.

## How it works

- Fetches `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard` (no auth required).
- Matches each pool player to the field using accent-tolerant name normalization.
- Sums each team's to-par scores; sorts ascending.
- Auto-refreshes every 60 seconds.

## Local preview

```
cd ~/projects/golf-pool
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

Push to a GitHub repo with Pages enabled → `volcanicsand.github.io/golf-pool/` (or whatever the repo is named).

## Notes

- For missed cut: ESPN keeps the cut player's score field; the player's row is dimmed but their score still counts toward the team total. If you want a different rule (e.g., +6 for each remaining round, or drop missed-cut player entirely), edit the logic in `app.js`.
- The "Match warnings" section surfaces any roster name that didn't match a player in the field. Currently three players need accent-tolerant matching: Højgaard, Åberg, Niemann — handled by the `norm()` function.
