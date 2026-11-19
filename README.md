# GTA VI trophy rarity forecast

[![Competition](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)
[![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/aan314183/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)
[![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/aan314183/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)

Forecast, for every PlayStation 5 trophy of Grand Theft Auto VI, the percent
of Exophase-tracked players who will have earned it at 2026-11-26T00:00:00Z,
a week after launch — as five quantiles per trophy (5%, 25%, 50%, 75%, 95%),
scored by pinball loss on the logit scale.

## Method

`main.ts` (Node 22, standard library only, no network) reads every
`<id>.in` case file and writes `<id>.out` with one row per trophy.

A rate is earners over players tracked, and both move fast in launch week
in opposite directions for the rate: new players dilute it, existing players
earning trophies lift it. So each trophy is modelled through its two counts
separately, in log-time since release (`u = ln(1 + hours since release)`),
and the rate is rebuilt from the two forecasts:

- `ln(earners) ~ a + b·u` and `ln(players) ~ a + b·u`, fit by least squares
  over the case's distinct reads (consecutive identical reads collapse to
  one point, so a frozen page cannot outweigh live reads);
- the fitted median is blended with the last observed rate in logit space,
  trusting the fit more when its residuals are small and it has many points;
- a soft ceiling by tier (platinum lowest), never below the last observed
  rate; when history is too thin for a fit, a small prior from the trophy's
  own description (chapter number, grind/collection wording, "final
  mission", "100%") nudges the last rate instead.

The logit spread is built honestly from the sources of doubt — a base term,
a term growing with the horizon, the fit's residual spread, a staleness term
that widens the band a lot when every read in the history is identical
(the page is frozen and the next Exophase refresh can move every rate at
once), and a dilution term from the forecast growth in players tracked —
then `q_tau = 100 / (1 + exp(-(logit(m) + z_tau · s)))`.

The program is fully deterministic: two runs on the same case write
byte-identical output.

## Sources

- Rates: Exophase's Grand Theft Auto VI PS5 trophy page
  (<https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/>),
  as recorded by the house and supplied in each case file.
- Competition: [gta6-trophy-rarity-forecast-01 on make.fun](https://make.fun/competitions/gta6-trophy-rarity-forecast-01)

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
