// GTA VI trophy rarity forecast (Node 22, standard library only).
//
// For every trophy of Grand Theft Auto VI on PlayStation 5, forecast its earn
// rate on Exophase at the case's target as five quantiles (5/25/50/75/95%),
// scored by pinball loss on the logit scale.
//
// Idea. A rate is a ratio: earners over players tracked. Both move fast in
// launch week, and in opposite directions for the rate: new players arrive
// (which dilutes every rate) while existing players keep earning (which lifts
// them). So each trophy is modelled through its two counts separately, in
// log-time since release, and the rate is rebuilt from the two forecasts:
//
//   ln(earners) ~ aE + bE * u,   ln(players) ~ aP + bP * u,
//   u = ln(1 + hours since release),   rate* = earners* / players*.
//
// Log-time already saturates: from two days in to a week in, u only grows
// about a quarter, so a straight line in u cannot run away. The fitted
// median is then blended with the last observed rate in logit space (the
// blend trusts the fit more when its residuals are small and it has many
// distinct reads), capped softly by tier, and never capped below the last
// observed rate. When the history is too thin for a fit, a small keyword
// prior on the trophy's own description (chapter number, grind/collection
// wording, "final mission", "100%") nudges the last rate instead.
//
// Spread. Pinball loss on the logit scale punishes narrow bands hardest, so
// the logit spread s is built honestly from the sources of doubt and the
// quantiles are q_tau = 100 / (1 + exp(-(logit(m) + z_tau * s))):
//   - a base term, and a random-walk term growing with the horizon;
//   - the fit's residual spread (noisy trophies get wider bands);
//   - a staleness term: when every read in the history is identical, the
//     page is frozen and Exophase's next refresh can move every rate at
//     once, so the band widens a lot (this is what the practice cases test);
//   - a dilution term from how much the tracked-player forecast grows.
// Fully deterministic: no randomness, no network, no clock reads.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface Game {
  name: string;
  platform: string;
  release_date: string;
  source: string;
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: Game;
  trophies: Trophy[];
  history: Read[];
  notes?: string;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** A percent clamped the way the scorer clamps it before the logit. */
const clampPct = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

interface Ols {
  a: number;
  b: number;
  resid: number;
  n: number;
}

/** Ordinary least squares of ys on xs; null when there is nothing to fit. */
function ols(xs: number[], ys: number[]): Ols | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-9) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a + b * xs[i]);
    ss += e * e;
  }
  return { a, b, resid: Math.sqrt(ss / (n - 2)), n };
}

/** Soft ceiling for a trophy's median rate by tier (week one, GTA launch). */
function tierCap(tier: string): number {
  if (tier === 'platinum') return 8;
  if (tier === 'gold') return 35;
  if (tier === 'silver') return 55;
  return 99.5;
}

/** Fallback median (percent) when a trophy has no history at all. */
function tierPrior(tier: string): number {
  if (tier === 'platinum') return 1;
  if (tier === 'gold') return 4;
  if (tier === 'silver') return 6;
  return 12;
}

/**
 * Small prior nudge in logit units, from the trophy's own description, used
 * only when its history is too thin to fit. Story chapters early in the game
 * run hot, the finale and 100% completion run cold, and grind/collection
 * wordings ("all", "every", big counts) run cold.
 */
function keywordAdjust(t: Trophy): number {
  const d = (t.description ?? '').toLowerCase();
  const ch = d.match(/chapter\s*(\d+)/);
  if (ch) {
    const n = parseInt(ch[1], 10);
    if (n <= 2) return 0.35;
    if (n >= 5) return -0.5;
    return -0.15;
  }
  if (d.includes('final mission')) return -0.6;
  if (d.includes('100%') || d.includes('100 percent')) return -0.8;
  if (/all |every |each gang|250 |50 challenges|collectible card|all of leonida|all garage|all shooting/.test(d)) return -0.45;
  if (d.includes('complete ')) return -0.1;
  return 0;
}

interface Point {
  u: number;
  earners: number;
  players: number;
  rate: number;
}

/** Forecast one case: one five-quantile row per trophy. */
function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const history = c.history ?? [];
  const releaseMs =
    Date.parse(c.game?.release_date ?? '') ||
    (history.length > 0 ? Date.parse(history[0].at) : Date.parse(c.at));
  const targetMs =
    Date.parse(c.target ?? '') || Date.parse(c.at) + (c.horizon_minutes ?? 0) * 60000;
  const uOf = (ms: number): number =>
    Math.log(1 + Math.max(0, (ms - releaseMs) / 3600000));
  const uTarget = uOf(targetMs);
  const horizonDays = Math.max(0, (c.horizon_minutes ?? 0) / 1440);

  // Staleness of the whole history: how many distinct pages were ever seen.
  // One distinct page means the counts are frozen and the next Exophase
  // refresh can shift every rate at once.
  let distinctPages = 0;
  let prevPage = '';
  for (const h of history) {
    const key = `${h.players_tracked}|${h.rates.join(',')}`;
    if (key !== prevPage) {
      distinctPages++;
      prevPage = key;
    }
  }
  const stale = distinctPages <= 1 ? 0.85 : distinctPages === 2 ? 0.45 : 0;
  const horizonTerm = 0.5 * Math.sqrt(horizonDays);

  return c.trophies.map((t, i) => {
    // Distinct reads for this trophy: consecutive reads with the same
    // players-tracked and the same rate carry no new information, so they
    // collapse to one point (a frozen page must not outweigh live reads).
    const pts: Point[] = [];
    let prevKey = '';
    for (const h of history) {
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      const key = `${h.players_tracked}|${r}`;
      if (key === prevKey) continue;
      prevKey = key;
      pts.push({
        u: uOf(Date.parse(h.at)),
        earners: Math.max(0.5, (r / 100) * h.players_tracked),
        players: Math.max(1, h.players_tracked),
        rate: r,
      });
    }

    const lastRead = history[history.length - 1];
    const lastRate =
      lastRead !== undefined && lastRead.rates[i] !== null && lastRead.rates[i] !== undefined
        ? (lastRead.rates[i] as number)
        : pts.length > 0
          ? pts[pts.length - 1].rate
          : null;

    // No history at all for this trophy: tier prior, very wide band.
    if (lastRate === null) {
      const m = tierPrior(t.tier);
      const s = 2.0;
      const lm = logit(m);
      const q = Z.map((z) => round4(clampPct(invLogitPct(lm + z * s))));
      return { id: t.id, q };
    }

    let logitMedian = logit(lastRate);
    let residLogit = 0.5;
    let dilution = 0;

    // No fit possible, or the fit failed: last rate plus a small prior
    // nudge from the trophy's own description — but never nudge a rate
    // that already sits at an extreme (0% or ~100%): there the data speaks.
    const weakMedian = (): number =>
      logit(lastRate) + (lastRate >= 99 || lastRate <= 0.05 ? 0 : keywordAdjust(t));

    if (pts.length >= 3) {
      const us = pts.map((p) => p.u);
      const uSpan = us[us.length - 1] - us[0];
      const fitEarners = ols(us, pts.map((p) => Math.log(p.earners)));
      const fitPlayers = ols(us, pts.map((p) => Math.log(p.players)));
      const fitLogit = ols(us, pts.map((p) => logit(p.rate)));
      if (fitEarners && fitPlayers && uSpan > 0.05) {
        const earnersStar = Math.exp(fitEarners.a + fitEarners.b * uTarget);
        const playersStar = Math.exp(fitPlayers.a + fitPlayers.b * uTarget);
        const rateFit = clampPct((100 * earnersStar) / playersStar);
        if (fitLogit) residLogit = clamp(fitLogit.resid, 0, 1.2);
        // Trust the fit more when it fits cleanly and has many points.
        const wBase = 0.7 - 0.25 * Math.min(1, residLogit);
        const w = wBase * (0.6 + 0.4 * Math.min(1, pts.length / 10));
        logitMedian = (1 - w) * logit(lastRate) + w * logit(rateFit);
        // Uncertainty from the player growth the forecast itself implies.
        const playersLast = pts[pts.length - 1].players;
        dilution = 0.35 * Math.max(0, Math.log(playersStar / Math.max(1, playersLast)));
      } else {
        logitMedian = weakMedian();
      }
    } else {
      logitMedian = weakMedian();
    }

    // Soft tier cap, never below the last observed rate.
    let median = invLogitPct(logitMedian);
    median = Math.min(median, Math.max(tierCap(t.tier), lastRate));
    median = clamp(median, 0.02, 99.99);

    const spread = clamp(
      Math.sqrt(
        0.36 +
          horizonTerm * horizonTerm +
          (0.8 * residLogit) * (0.8 * residLogit) +
          stale * stale +
          dilution * dilution,
      ),
      0.7,
      2.4,
    );

    const lm = logit(median);
    const q = Z.map((z) => round4(clampPct(invLogitPct(lm + z * spread))));
    for (let k = 1; k < q.length; k++) {
      if (q[k] < q[k - 1]) q[k] = q[k - 1];
    }
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
