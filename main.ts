// GTA VI trophy rarity forecast — week-one Exophase earn rates for all 55 PS5 trophies.
//
// What it does: for every trophy in the case file it forecasts five quantiles of the
// percent of Exophase-tracked players who will hold that trophy at the case's target
// (2026-11-26T00:00:00Z in the final). It reads nothing but the case file: no trophy
// name, description or rate is hard-coded here, and it runs offline on Node's standard
// library only.
//
// Method, in log-time since release. Let u(t) = ln(1 + hours since the game's release,
// 2026-11-19T00:00:00Z). Trophy progress is fast at first and then flattens, which is
// what log-time captures: equal steps in u are the early hours, then the later days.
//
//   - Players tracked: a least-squares line of ln(players) against u over the case's
//     reads, read at the target. New players keep joining after launch, so the tracked
//     base keeps growing; fitting it on its own keeps that growth out of the trophies.
//   - Earners per trophy: earners = rate * players / 100 in each read, then a
//     least-squares line of ln(earners) against u, read at the target. The median rate
//     is 100 * earners(target) / players(target). Earners only grow as players play,
//     so the slope is kept inside [-0.5, players-slope + 1.2]; a flat history (every
//     read the same, as on launch night) gives slope 0 and the median is the last rate.
//   - Tier caps on the median, because a week is short: platinum at most 8%, gold at
//     most 35%, silver at most 55%. Early story bronzes are left uncapped — one of them
//     already sits at 100% in the last read, and it stays there.
//   - Spread, honest and wide on the logit scale. Four parts, added in quadrature:
//     a random-walk term 0.5 * sqrt(horizon in days), as the house baseline; a 0.85
//     staleness term, because Exophase refreshes a game's counts on its own schedule —
//     on launch night the page sat unchanged at 638 players from 23:48 UTC to 04:00 UTC
//     and only then refreshed to 3,868 players, so any single read can be hours stale;
//     an extrapolation term 0.4 per unit of log-time past the last read; and each fit's
//     own residual scatter. A 90% band is therefore roughly a factor of four either way
//     on a 90-minute practice case, and wider on the seven-day final, which is what a
//     two-day-old game's week-one rates deserve.
//
// Output: one <id>.out per <id>.in, {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]},
// quantiles rounded to 4 decimals, non-decreasing, deterministic: the same input bytes
// always produce the same output bytes, and a run takes a fraction of a second.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The standard normal's quantile at each scored level [0.05, 0.25, 0.5, 0.75, 0.95]. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Week-one ceiling on the median rate, by trophy tier (percent). Bronze is uncapped. */
const TIER_CAP: Record<string, number> = { platinum: 8, gold: 35, silver: 55 };
/** Logit units of spread for Exophase's own refresh schedule (see header). */
const STALENESS = 0.85;
/** Logit units of spread per square-root day, as the house baseline. */
const WALK = 0.5;
/** Logit units of spread per unit of log-time extrapolated past the last read. */
const EXTRAP = 0.4;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const logit = (pct: number): number => {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-clamp(l, -30, 30)));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Trophy {
  id: number;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
}

/** Least-squares line y = a + b*x, plus the RMS residual. A flat x gives slope 0. */
function fitLine(xs: number[], ys: number[]): { a: number; b: number; rms: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    se += r * r;
  }
  return { a, b, rms: Math.sqrt(se / n) };
}

const HOUR_MS = 3_600_000;
/** Log-time since release: ln(1 + hours from the release instant to t). */
const uOf = (t0: number, t: number): number => Math.log1p(Math.max(0, (t - t0) / HOUR_MS));

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const t0 = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const uTarget = uOf(t0, Date.parse(c.target));
  const days = c.horizon_minutes / 1440;

  // Players tracked: one log-linear fit in log-time since release.
  const pXs: number[] = [];
  const pYs: number[] = [];
  let uLast = 0;
  for (const h of c.history) {
    uLast = uOf(t0, Date.parse(h.at));
    if (typeof h.players_tracked === 'number' && h.players_tracked > 0) {
      pXs.push(uLast);
      pYs.push(Math.log(h.players_tracked));
    }
  }
  const pFit =
    pXs.length >= 2
      ? fitLine(pXs, pYs)
      : { a: pYs[0] ?? 0, b: 0, rms: 0 };
  const bPlayers = clamp(pFit.b, -0.5, 2.5);
  const playersTarget = Math.exp(pFit.a + bPlayers * uTarget);

  // Spread parts shared by every trophy: walk, staleness, extrapolation, players fit.
  const dU = Math.max(0, uTarget - uLast);
  const baseVar =
    (WALK * Math.sqrt(days)) ** 2 +
    STALENESS ** 2 +
    (EXTRAP * dU) ** 2 +
    Math.min(1.2, pFit.rms) ** 2;

  const trophies = c.trophies.map((t, i) => {
    // This trophy's earners: one log-linear fit in log-time since release.
    const eXs: number[] = [];
    const eYs: number[] = [];
    for (const h of c.history) {
      const r = h.rates[i];
      if (
        typeof r === 'number' &&
        r > 0 &&
        r < 100 &&
        typeof h.players_tracked === 'number' &&
        h.players_tracked > 0
      ) {
        eXs.push(uOf(t0, Date.parse(h.at)));
        eYs.push(Math.log((r / 100) * h.players_tracked));
      }
    }
    // The most recent non-null rate, for the flat-history and fallback paths.
    let lastRate = 0;
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (typeof r === 'number') {
        lastRate = r;
        break;
      }
    }

    let median: number;
    let resid = 0;
    if (eXs.length >= 2) {
      const eFit = fitLine(eXs, eYs);
      const bEarners = clamp(eFit.b, -0.5, bPlayers + 1.2);
      const earnersTarget = Math.exp(eFit.a + bEarners * uTarget);
      median = (100 * earnersTarget) / Math.max(1, playersTarget);
      resid = Math.min(1, eFit.rms);
    } else if (lastRate > 0) {
      median = lastRate;
    } else {
      median = 0.5;
    }
    const cap = TIER_CAP[t.tier] ?? 100;
    median = clamp(median, 0.01, cap);
    // A trophy the last read shows at 100% stays at 100%: its earners are the players.
    if (lastRate >= 100) median = 100;

    const spread = Math.sqrt(baseVar + resid * resid);
    const centre = logit(median);
    const q = Z.map((z) => round4(clamp(invLogitPct(centre + z * spread), 0.01, 100)));
    // Rounding guard: keep the quantiles non-decreasing.
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    return { id: t.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
