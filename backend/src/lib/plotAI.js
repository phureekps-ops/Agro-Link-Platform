/**
 * AgroLink SatAI — กลุ่มที่ 1 (แกนโครงการ NIA T69-10-239), pure computation
 * part. No database, no network: every function takes plain data and
 * returns plain data, so the whole thing is unit-testable (see
 * test/plotAI.test.js) and the DB-facing half (lib/plotAIService.js) stays
 * thin.
 *
 *   AI 1  จำแนกชนิดพืช วันปลูก วันเก็บเกี่ยว — phenology from the plot's
 *         clear-sky Sentinel-2 NDVI series (satellite.observation), a
 *         knowledge-based rule set as the always-available baseline, and a
 *         softmax classifier trained on member-confirmed labels
 *         (ai.ground_truth) that only takes over once it beats the rules
 *         in cross-validation.
 *   AI 2  พยากรณ์ผลผลิต — crop-profile baseline scaled by the season's
 *         NDVI peak, and a ridge regression per crop trained on the weights
 *         the cooperative actually recorded (produce.delivery), again only
 *         activated once it beats the baseline in cross-validation.
 *   AI 3  ตรวจความผิดปกติ — explainable checks of what the plot's records
 *         say (declared crop, delivery dates and tons, harvest stage,
 *         registered area) against what the satellite saw.
 *   AI 4  ยกระดับเครดิต — plotHealthFactor() turns a farmer's latest plot
 *         assessments into one 0-100 factor that risk.compute_credit_score()
 *         can feed to the credit model (grant_plot_ai.sql).
 *
 * Honesty rules kept throughout (same stance as the credit model in
 * grant_credit_model.sql): every result says which method produced it
 * (rule_based_* / ml_*), a learned model never replaces the baseline
 * unless it measurably does better on held-out data, and NDVI alone cannot
 * reliably tell rice from maize — when the two are close the result says
 * so instead of guessing.
 */

const DAY_MS = 864e5;
const STEP_DAYS = 10;          // composite period
const MAX_INTERP_GAP = 90;     // days of missing composites we will bridge (a crop cycle is longer)
const MIN_PEAK = 0.45;         // NDVI a growing crop should reach
const MIN_PROMINENCE = 0.15;   // rise above the surrounding lows
const MIN_PEAK_SEPARATION = 40;

const CROPS = ['rice', 'maize', 'cassava', 'sugarcane', 'vegetable', 'perennial', 'fallow'];
const CROP_TH = {
  rice: 'ข้าว',
  maize: 'ข้าวโพด',
  cassava: 'มันสำปะหลัง',
  sugarcane: 'อ้อย',
  vegetable: 'ผัก/พืชอายุสั้น',
  perennial: 'ไม้ยืนต้น/ไม้ผล',
  fallow: 'ไม่มีพืชปลูก/พื้นที่ว่าง',
};
const ANNUAL_FIELD_CROPS = ['rice', 'maize', 'cassava', 'sugarcane'];

/** registry.commodity_ref code → crop class used by the models. */
function commodityToCrop(code) {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('RICE')) return 'rice';
  if (c.startsWith('CORN') || c.startsWith('MAIZE')) return 'maize';
  if (c.startsWith('CASSAVA')) return 'cassava';
  if (c.startsWith('SUGAR')) return 'sugarcane';
  if (/^(DURIAN|COCONUT|COFFEE|LONGAN|PALM|RUBBER|MANGO|LYCHEE|RAMBUTAN|MANGOSTEEN)/.test(c)) return 'perennial';
  if (c.startsWith('VEG')) return 'vegetable';
  return null;
}

// ---------------------------------------------------------------- dates
function toDay(v) {
  if (v instanceof Date) return Math.floor(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) / DAY_MS);
  return Math.floor(Date.parse(String(v).slice(0, 10)) / DAY_MS);
}
function dayToIso(d) {
  if (d === null || d === undefined || !Number.isFinite(d)) return null;
  return new Date(Math.round(d) * DAY_MS).toISOString().slice(0, 10);
}

// ------------------------------------------------------- 1. the series
/**
 * 10-day maximum-value composites of the clear-sky NDVI points, gaps up to
 * MAX_INTERP_GAP days bridged linearly, then a light [1,2,1] smoothing.
 * Points: [{date:'YYYY-MM-DD', ndvi}]. Covers [asOfDay - windowDays, asOfDay].
 */
function composite(points, asOfDay, windowDays = 540) {
  const start = asOfDay - windowDays;
  const n = Math.floor(windowDays / STEP_DAYS) + 1;
  const raw = new Array(n).fill(null);
  let nObs = 0;
  const obsDays = [];
  for (const p of points || []) {
    const v = Number(p.ndvi);
    if (!Number.isFinite(v)) continue;
    const d = toDay(p.date);
    if (d < start || d > asOfDay) continue;
    const i = Math.min(n - 1, Math.floor((d - start) / STEP_DAYS));
    raw[i] = raw[i] === null ? v : Math.max(raw[i], v);
    nObs += 1;
    obsDays.push(d);
  }
  obsDays.sort((a, b) => a - b);
  const filled = raw.slice();
  let last = -1;
  for (let i = 0; i < n; i += 1) {
    if (raw[i] === null) continue;
    if (last >= 0 && i - last > 1 && (i - last) * STEP_DAYS <= MAX_INTERP_GAP) {
      for (let k = last + 1; k < i; k += 1) {
        filled[k] = raw[last] + (raw[i] - raw[last]) * ((k - last) / (i - last));
      }
    }
    last = i;
  }
  const vals = filled.map((v, i) => {
    if (v === null) return null;
    const a = i > 0 ? filled[i - 1] : null;
    const b = i < n - 1 ? filled[i + 1] : null;
    if (a === null || b === null) return v;
    return (a + 2 * v + b) / 4;
  });
  let maxGap = 0;
  for (let i = 1; i < obsDays.length; i += 1) maxGap = Math.max(maxGap, obsDays[i] - obsDays[i - 1]);
  if (obsDays.length) maxGap = Math.max(maxGap, asOfDay - obsDays[obsDays.length - 1]);
  return {
    start, step: STEP_DAYS, asOfDay, vals, observed: raw.map((v) => v !== null), nObs, maxGapDays: obsDays.length ? maxGap : windowDays,
    firstObsDay: obsDays.length ? obsDays[0] : null, lastObsDay: obsDays.length ? obsDays[obsDays.length - 1] : null,
  };
}

function binDay(series, i) { return series.start + i * series.step + series.step / 2; }

function segments(vals) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= vals.length; i += 1) {
    const ok = i < vals.length && vals[i] !== null;
    if (ok && s < 0) s = i;
    if (!ok && s >= 0) { out.push([s, i - 1]); s = -1; }
  }
  return out;
}

// --------------------------------------------- 2. growing-season finder
/**
 * Seasons = NDVI peaks of at least MIN_PEAK that rise MIN_PROMINENCE above
 * the lows around them. Start of season (SOS) = 20% of the rise, end of
 * season (EOS, ≈ harvest) = 50% of the fall. A season whose fall has not
 * happened yet at the end of the data is `ongoing`; one whose rise started
 * before the data is `truncatedLeft` (no SOS).
 */
function detectSeasons(series) {
  const { vals } = series;
  const seasons = [];
  const lastIdx = vals.length - 1;
  for (const [s, e] of segments(vals)) {
    if (e - s < 2) continue;
    const cands = [];
    for (let i = s; i <= e; i += 1) {
      const v = vals[i];
      const l = i > s ? vals[i - 1] : -Infinity;
      const r = i < e ? vals[i + 1] : -Infinity;
      if (v >= MIN_PEAK && v >= l && v > r) cands.push(i);
      else if (v >= MIN_PEAK && v > l && v >= r && i === e) cands.push(i);
    }
    const prom = (i) => {
      let lm = vals[i]; let j = i - 1;
      while (j >= s && vals[j] <= vals[i]) { lm = Math.min(lm, vals[j]); j -= 1; }
      let rm = vals[i]; let k = i + 1;
      while (k <= e && vals[k] <= vals[i]) { rm = Math.min(rm, vals[k]); k += 1; }
      // A side that runs into the edge of the data (no higher ground seen)
      // is unknown, not flat: judge the peak on the other side only.
      const leftOpen = j < s; const rightOpen = k > e;
      const lp = vals[i] - lm; const rp = vals[i] - rm;
      if (leftOpen && rightOpen) return Math.max(lp, rp);
      if (leftOpen) return rp;
      if (rightOpen) return lp;
      return Math.min(lp, rp);
    };
    let peaks = cands.filter((i) => prom(i) >= MIN_PROMINENCE);
    // merge peaks closer than MIN_PEAK_SEPARATION (keep the higher one)
    peaks.sort((a, b) => a - b);
    const kept = [];
    for (const p of peaks) {
      const prev = kept[kept.length - 1];
      if (prev !== undefined && (p - prev) * series.step < MIN_PEAK_SEPARATION) {
        if (vals[p] > vals[prev]) kept[kept.length - 1] = p;
      } else kept.push(p);
    }
    // a valley between two kept peaks must dip MIN_PROMINENCE below the lower one
    peaks = [];
    for (const p of kept) {
      const prev = peaks[peaks.length - 1];
      if (prev !== undefined) {
        const lo = Math.min(...vals.slice(prev, p + 1));
        if (Math.min(vals[prev], vals[p]) - lo < MIN_PROMINENCE) {
          if (vals[p] > vals[prev]) peaks[peaks.length - 1] = p;
          continue;
        }
      }
      peaks.push(p);
    }
    peaks.forEach((p, idx) => {
      const lo0 = idx === 0 ? s : peaks[idx - 1];
      const hi1 = idx === peaks.length - 1 ? e : peaks[idx + 1];
      let lb = p; for (let i = lo0; i <= p; i += 1) if (vals[i] <= vals[lb]) lb = i;
      let rb = p; for (let i = p; i <= hi1; i += 1) if (vals[i] < vals[rb]) rb = i;
      const peak = vals[p];
      const leftBase = vals[lb]; const rightBase = vals[rb];
      const truncatedLeft = lb === s && (peak - leftBase < MIN_PROMINENCE || leftBase > 0.4);
      let sosDay = null;
      if (!truncatedLeft) {
        const thr = leftBase + 0.2 * (peak - leftBase);
        for (let i = lb + 1; i <= p; i += 1) {
          if (vals[i] >= thr) {
            const a = vals[i - 1];
            const f = vals[i] !== a ? (thr - a) / (vals[i] - a) : 0;
            sosDay = binDay(series, i - 1 + f);
            break;
          }
        }
      }
      const fell = peak - rightBase >= MIN_PROMINENCE;
      let eosDay = null;
      if (fell) {
        const thr = rightBase + 0.5 * (peak - rightBase);
        for (let i = p; i <= rb; i += 1) {
          if (vals[i] <= thr) {
            const a = vals[i - 1];
            const f = vals[i] !== a ? (a - thr) / (a - vals[i]) : 1;
            eosDay = binDay(series, i - 1 + f);
            break;
          }
        }
      }
      const atDataEnd = e === lastIdx || (series.lastObsDay !== null && binDay(series, e) >= series.lastObsDay - series.step);
      const ongoing = !fell && atDataEnd;
      const peakDay = binDay(series, p);
      const endForLen = eosDay !== null ? eosDay : binDay(series, e);
      let auc = 0;
      const i0 = sosDay !== null ? Math.max(s, Math.round((sosDay - series.start) / series.step)) : lb;
      const i1 = eosDay !== null ? Math.min(e, Math.round((eosDay - series.start) / series.step)) : (fell ? rb : e);
      for (let i = i0; i <= i1; i += 1) auc += Math.max(0, vals[i] - 0.2) * series.step;
      let highRun = 0; let run = 0;
      for (let i = lb; i <= (fell ? rb : e); i += 1) {
        if (vals[i] >= 0.5) { run += series.step; highRun = Math.max(highRun, run); } else run = 0;
      }
      seasons.push({
        sosDay, peakDay, eosDay, peak, leftBase, rightBase,
        amplitude: peak - Math.min(leftBase, rightBase),
        lengthDays: sosDay !== null && eosDay !== null ? eosDay - sosDay : null,
        lengthSoFar: sosDay !== null ? endForLen - sosDay : null,
        ongoing, gapAfter: !fell && !atDataEnd, truncatedLeft,
        greenupPer10d: sosDay !== null ? ((peak - leftBase) / Math.max(10, peakDay - sosDay)) * 10 : null,
        senescencePer10d: eosDay !== null ? ((peak - rightBase) / Math.max(10, eosDay - peakDay)) * 10 : null,
        auc, highRunDays: highRun,
      });
    });
  }
  return seasons;
}

// ---------------------------------------------------- 3. feature vector
const FEATURE_KEYS = ['mean', 'std', 'min', 'max', 'p10', 'p90', 'fracHigh', 'fracLow', 'nSeasons',
  'peak', 'amplitude', 'length', 'greenup', 'senescence', 'highRun', 'auc'];

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Features of the 365 days up to series.asOfDay. `main` = the season with
 * the highest peak in that year (or null); seasonal features fall back to
 * neutral values when there is no season, and `length` falls back to the
 * length so far (marked in `lengthKnown`).
 */
function extractFeatures(series, seasons) {
  const from = series.asOfDay - 365;
  const yearVals = []; let observedBins = 0;
  series.vals.forEach((v, i) => {
    if (binDay(series, i) < from) return;
    if (v !== null) yearVals.push(v);
    if (series.observed && series.observed[i]) observedBins += 1;
  });
  const sorted = yearVals.slice().sort((a, b) => a - b);
  const m = yearVals.length ? yearVals.reduce((s, v) => s + v, 0) / yearVals.length : null;
  const sd = yearVals.length ? Math.sqrt(yearVals.reduce((s, v) => s + (v - m) ** 2, 0) / yearVals.length) : null;
  const inYear = seasons.filter((s) => s.peakDay >= from);
  // The season that describes the crop best: a complete one (known length)
  // first, then the highest peak. `latest` drives dates and the forecast.
  const main = inYear.slice().sort((a, b) => ((b.lengthDays !== null) - (a.lengthDays !== null)) || (b.peak - a.peak))[0] || null;
  const latest = inYear.slice().sort((a, b) => b.peakDay - a.peakDay)[0] || null;
  let highRun = 0; let run = 0;
  series.vals.forEach((v, i) => {
    if (binDay(series, i) < from) return;
    if (v !== null && v >= 0.5) { run += series.step; highRun = Math.max(highRun, run); } else run = 0;
  });
  const length = main ? (main.lengthDays !== null ? main.lengthDays : main.lengthSoFar) : null;
  return {
    coverage: observedBins / Math.ceil(365 / series.step),
    nObs: series.nObs,
    mean: m, std: sd, min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null,
    p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9),
    fracHigh: yearVals.length ? yearVals.filter((v) => v >= 0.6).length / yearVals.length : null,
    fracLow: yearVals.length ? yearVals.filter((v) => v < 0.3).length / yearVals.length : null,
    nSeasons: inYear.length,
    peak: main ? main.peak : (sorted[sorted.length - 1] ?? null),
    amplitude: main ? main.amplitude : 0,
    length, lengthKnown: !!(main && main.lengthDays !== null),
    greenup: main && main.greenupPer10d !== null ? main.greenupPer10d : 0,
    senescence: main && main.senescencePer10d !== null ? main.senescencePer10d : 0,
    highRun, auc: main ? main.auc : 0,
    seasonComplete: !!(main && main.lengthDays !== null),
    mainSeason: main, latestSeason: latest,
  };
}

function featureVector(f) {
  return FEATURE_KEYS.map((k) => {
    const v = f[k];
    if (v === null || v === undefined || !Number.isFinite(v)) return k === 'length' ? 0 : 0;
    return v;
  });
}

// ------------------------------------- 4. crop rules (always available)
/** trapezoid membership: 0 below a, ramps to 1 at b, 1 to c, ramps to 0 at d */
function trap(x, a, b, c, d) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0.5;
  if (x < a || x > d) return 0;
  if (x < b) return b === a ? 1 : (x - a) / (b - a);
  if (x <= c) return 1;
  return d === c ? 1 : (d - x) / (d - c);
}
const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

/**
 * Knowledge-based phenology rules for Thai field crops. Returns a score
 * per crop (0-1), the best crop, a confidence and a Thai explanation.
 * Rice and maize have near-identical NDVI curves; the result marks them as
 * ambiguous rather than pretending otherwise (Sentinel-1 radar flooding
 * is what separates them — a later step).
 */
function ruleCropScores(f) {
  const s = {};
  if (f.max === null) {
    CROPS.forEach((c) => { s[c] = 0; });
    return s;
  }
  const len = f.length;
  const ongoingLen = f.mainSeason && f.mainSeason.lengthDays === null;
  const lenScore = (a, b, c, d) => {
    if (len === null) return 0.75;
    if (ongoingLen) return len >= d ? 0 : (len >= b ? Math.max(trap(len, a, b, c, d), 0.7) : 0.7);
    return trap(len, a, b, c, d);
  };
  const seasonsOk = f.nSeasons >= 1 && f.nSeasons <= 3 ? 1 : 0;
  // Season length is a hard constraint (a 7-month "rice" season does not
  // exist), so it multiplies the other criteria instead of averaging in.
  // Lengths are SOS(20% of the rise) → EOS(50% of the fall), which runs
  // shorter than sowing → harvest: rice ≈ 70-125 days on this measure.
  s.rice = f.nSeasons === 0 ? 0 : lenScore(55, 70, 125, 160) * avg([trap(f.peak, 0.45, 0.6, 1, 1.01),
    trap(f.mainSeason ? Math.min(f.mainSeason.leftBase, f.mainSeason.rightBase) : f.min, -1, -1, 0.35, 0.5), seasonsOk]);
  s.maize = f.nSeasons === 0 ? 0 : 0.92 * lenScore(55, 70, 115, 145) * avg([trap(f.peak, 0.5, 0.68, 1, 1.01), seasonsOk,
    trap(f.greenup, 0.04, 0.08, 1, 2)]);
  s.cassava = lenScore(170, 210, 330, 390) * avg([trap(f.highRun, 60, 110, 260, 320), trap(f.peak, 0.5, 0.6, 0.9, 1.01),
    f.nSeasons <= 1 ? 1 : 0.3]);
  s.sugarcane = lenScore(220, 270, 420, 520) * avg([trap(f.highRun, 140, 190, 400, 500), trap(f.peak, 0.6, 0.72, 1, 1.01),
    f.nSeasons <= 1 ? 1 : 0.2]);
  s.perennial = avg([trap(f.min, 0.3, 0.45, 1, 1.01), trap(f.fracHigh, 0.5, 0.75, 1, 1.01), trap(f.std, -1, -1, 0.07, 0.13)]);
  const shortCycles = f.mainSeason && f.length !== null && !ongoingLen ? trap(f.length, 15, 25, 60, 80) : 0;
  s.vegetable = Math.max(
    f.nSeasons >= 3 ? 0.8 : 0,
    shortCycles * 0.8,
    // vegetated most of the year with no field-crop cycle (no harvest drop)
    f.nSeasons === 0 ? avg([trap(f.mean, 0.3, 0.4, 0.75, 0.85), trap(f.max, 0.45, 0.55, 1, 1.01), trap(f.std, 0.03, 0.06, 0.25, 0.35)]) * 0.75 : 0,
  );
  s.fallow = trap(f.max, -1, -1, 0.35, 0.45);
  Object.keys(s).forEach((k) => { s[k] = Math.max(0, Math.min(1, s[k])); });
  return s;
}

function pickCrop(scores, method, incomplete = false) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const [second, secondScore] = ranked[1] || [null, 0];
  const margin = bestScore - secondScore;
  let confidence = method.startsWith('ml') ? bestScore : Math.min(0.95, bestScore * (0.6 + 0.4 * Math.min(1, margin / 0.3)));
  // A season still growing (or seen only in part) has not shown its length yet.
  if (!method.startsWith('ml') && incomplete) confidence *= 0.7;
  const ambiguousPair = ['rice', 'maize'].includes(best) && ['rice', 'maize'].includes(second) && margin < 0.15;
  if (ambiguousPair && !method.startsWith('ml')) confidence = Math.min(confidence, 0.55);
  if (bestScore < 0.35) return { crop: null, confidence: 0, second, scores, method, ambiguous: false };
  return { crop: best, confidence: Math.round(confidence * 100) / 100, second, scores, method, ambiguous: ambiguousPair };
}

// -------------------------------------------------- 5. small ML helpers
function standardizer(rows) {
  const d = rows[0].length;
  const means = new Array(d).fill(0); const stds = new Array(d).fill(0);
  rows.forEach((r) => r.forEach((v, j) => { means[j] += v / rows.length; }));
  rows.forEach((r) => r.forEach((v, j) => { stds[j] += (v - means[j]) ** 2 / rows.length; }));
  for (let j = 0; j < d; j += 1) stds[j] = Math.max(Math.sqrt(stds[j]), 1e-6);
  return { means, stds, apply: (r) => r.map((v, j) => (v - means[j]) / stds[j]) };
}

/** multinomial logistic regression, L2, batch gradient descent */
function trainSoftmax(X, y, classes, { epochs = 600, lr = 0.3, l2 = 0.05 } = {}) {
  const k = classes.length; const d = X[0].length; const n = X.length;
  const W = Array.from({ length: k }, () => new Array(d).fill(0)); const b = new Array(k).fill(0);
  const yi = y.map((c) => classes.indexOf(c));
  for (let ep = 0; ep < epochs; ep += 1) {
    const gW = Array.from({ length: k }, () => new Array(d).fill(0)); const gb = new Array(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      const p = softmaxProbs(W, b, X[i]);
      for (let c = 0; c < k; c += 1) {
        const err = p[c] - (yi[i] === c ? 1 : 0);
        gb[c] += err;
        for (let j = 0; j < d; j += 1) gW[c][j] += err * X[i][j];
      }
    }
    for (let c = 0; c < k; c += 1) {
      b[c] -= lr * gb[c] / n;
      for (let j = 0; j < d; j += 1) W[c][j] -= lr * (gW[c][j] / n + l2 * W[c][j]);
    }
  }
  return { W, b, classes };
}
function softmaxProbs(W, b, x) {
  const z = W.map((w, c) => b[c] + w.reduce((s, wj, j) => s + wj * x[j], 0));
  const mx = Math.max(...z); const e = z.map((v) => Math.exp(v - mx)); const t = e.reduce((s, v) => s + v, 0);
  return e.map((v) => v / t);
}

/** ridge regression via normal equations (d is small) */
function trainRidge(X, y, l2 = 1) {
  const n = X.length; const d = X[0].length + 1;
  const A = Array.from({ length: d }, () => new Array(d).fill(0)); const v = new Array(d).fill(0);
  for (let i = 0; i < n; i += 1) {
    const r = [1, ...X[i]];
    for (let a = 0; a < d; a += 1) { v[a] += r[a] * y[i]; for (let c = 0; c < d; c += 1) A[a][c] += r[a] * r[c]; }
  }
  for (let a = 1; a < d; a += 1) A[a][a] += l2;
  return solve(A, v);
}
function solve(A, v) {
  const n = v.length; const M = A.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

function kFolds(n, k) {
  const idx = Array.from({ length: n }, (_, i) => i);
  // deterministic shuffle (so retraining on the same data gives the same report)
  let seed = 7;
  for (let i = n - 1; i > 0; i -= 1) { seed = (seed * 9301 + 49297) % 233280; const j = Math.floor((seed / 233280) * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const folds = Array.from({ length: Math.min(k, n) }, () => []);
  idx.forEach((v, i) => folds[i % folds.length].push(v));
  return folds;
}

// ------------------------------------- 6. crop classifier (trainable)
const CROP_MODEL_MIN_SAMPLES = 30;
const CROP_MODEL_MIN_PER_CLASS = 5;
const CROP_MODEL_MIN_ACCURACY = 0.6;

function cropModelInput(f) {
  const rs = ruleCropScores(f);
  return [...featureVector(f), ...CROPS.map((c) => rs[c])];
}

/**
 * samples: [{features, crop}] (crop = confirmed label). Trains only on
 * classes with ≥ CROP_MODEL_MIN_PER_CLASS labels, scores 5-fold CV accuracy
 * against the rule baseline on the SAME labels, and says whether it may be
 * activated (it must beat the rules and reach CROP_MODEL_MIN_ACCURACY).
 */
function trainCropModel(samples) {
  const counts = {};
  samples.forEach((s) => { counts[s.crop] = (counts[s.crop] || 0) + 1; });
  const classes = CROPS.filter((c) => (counts[c] || 0) >= CROP_MODEL_MIN_PER_CLASS);
  const usable = samples.filter((s) => classes.includes(s.crop));
  const report = { sample_size: samples.length, usable_size: usable.length, class_counts: counts, classes };
  if (usable.length < CROP_MODEL_MIN_SAMPLES || classes.length < 2) {
    return { ...report, activated: false, reason: 'insufficient_data', min_samples: CROP_MODEL_MIN_SAMPLES, min_per_class: CROP_MODEL_MIN_PER_CLASS };
  }
  const X = usable.map((s) => cropModelInput(s.features));
  const y = usable.map((s) => s.crop);
  let mlCorrect = 0; let ruleCorrect = 0;
  for (const fold of kFolds(usable.length, 5)) {
    const tr = usable.map((_, i) => i).filter((i) => !fold.includes(i));
    const st = standardizer(tr.map((i) => X[i]));
    const m = trainSoftmax(tr.map((i) => st.apply(X[i])), tr.map((i) => y[i]), classes);
    fold.forEach((i) => {
      const p = softmaxProbs(m.W, m.b, st.apply(X[i]));
      if (classes[p.indexOf(Math.max(...p))] === y[i]) mlCorrect += 1;
    });
  }
  usable.forEach((s) => { if (pickCrop(ruleCropScores(s.features), 'rule').crop === s.crop) ruleCorrect += 1; });
  const cvAccuracy = mlCorrect / usable.length; const ruleAccuracy = ruleCorrect / usable.length;
  const st = standardizer(X);
  const m = trainSoftmax(X.map(st.apply), y, classes);
  const activated = cvAccuracy >= CROP_MODEL_MIN_ACCURACY && cvAccuracy > ruleAccuracy;
  return {
    ...report, activated,
    reason: activated ? 'beats_rule_baseline' : (cvAccuracy <= ruleAccuracy ? 'not_better_than_rules' : 'below_min_accuracy'),
    metrics: { cv_accuracy: round(cvAccuracy, 3), rule_accuracy: round(ruleAccuracy, 3), folds: Math.min(5, usable.length) },
    params: { W: m.W, b: m.b, classes, means: st.means, stds: st.stds, feature_keys: [...FEATURE_KEYS, ...CROPS.map((c) => `rule_${c}`)] },
  };
}

function predictCropMl(params, f) {
  const x = cropModelInput(f).map((v, j) => (v - params.means[j]) / params.stds[j]);
  const p = softmaxProbs(params.W, params.b, x);
  const scores = {}; params.classes.forEach((c, i) => { scores[c] = p[i]; });
  return scores;
}

/**
 * The plot's crop: the active ML model when there is one and it is sure
 * enough (≥ 0.5), otherwise the rules. Too little data → crop null.
 */
function classifyCrop(f, activeCropModel) {
  if (f.max === null || f.coverage < 0.25) {
    return { crop: null, confidence: 0, method: 'insufficient_data', scores: {}, ambiguous: false };
  }
  const rule = pickCrop(ruleCropScores(f), 'rule_based_phenology', f.nSeasons > 0 && !f.seasonComplete);
  if (activeCropModel && activeCropModel.params) {
    const ml = pickCrop(predictCropMl(activeCropModel.params, f), 'ml_softmax');
    if (ml.crop && ml.confidence >= 0.5) return { ...ml, model_id: activeCropModel.model_id, rule_crop: rule.crop };
  }
  return rule;
}

// ----------------------------------------- 7. planting & harvest dates
function seasonDates(f, crop, profile, asOfDay) {
  const s = f.latestSeason;
  if (!s) return { planting_date: null, expected_harvest_date: null, harvest_date: null, season_status: 'no_season' };
  const plant = s.sosDay !== null ? s.sosDay - 10 : null; // NDVI starts rising ~10 days after sowing
  if (s.eosDay !== null) {
    return { planting_date: dayToIso(plant), harvest_date: dayToIso(s.eosDay), expected_harvest_date: null, season_status: 'harvested', peak_date: dayToIso(s.peakDay), peak_ndvi: round(s.peak, 3) };
  }
  // An expected harvest date only makes sense for a field crop with a profile.
  let expected = null; let note = null;
  if (ANNUAL_FIELD_CROPS.includes(crop) && profile) {
    if (profile.peak_to_harvest_days) expected = s.peakDay + Number(profile.peak_to_harvest_days);
    if (profile.typical_season_days && s.sosDay !== null) {
      const bySos = s.sosDay + Number(profile.typical_season_days);
      expected = expected === null ? bySos : Math.max(expected, bySos);
    }
    if (expected !== null && asOfDay !== undefined && expected < asOfDay) {
      expected = asOfDay + 15;
      note = 'เลยช่วงที่คาดไว้แล้วแต่ภาพล่าสุดยังไม่เห็นการเก็บเกี่ยว — น่าจะเก็บเกี่ยวเร็วๆ นี้';
    }
  }
  return {
    planting_date: dayToIso(plant), harvest_date: null, expected_harvest_date: dayToIso(expected), expected_harvest_note: note,
    season_status: s.ongoing ? 'growing' : 'unknown_gap', peak_date: dayToIso(s.peakDay), peak_ndvi: round(s.peak, 3),
  };
}

// ------------------------------------------------- 8. yield (AI 2)
const YIELD_MODEL_MIN_SAMPLES = 15;
const YIELD_FEATURE_KEYS = ['peak', 'amplitude', 'auc', 'length'];

/** Baseline t/rai: the crop profile's typical yield scaled by how green the season got. */
function baselineYieldPerRai(profile, season) {
  if (!profile || !profile.typical_yield_t_per_rai || !season || !season.peak) return null;
  const ref = Number(profile.reference_peak_ndvi) || 0.8;
  const k = Math.max(0.6, Math.min(1.25, season.peak / ref));
  return Number(profile.typical_yield_t_per_rai) * k;
}
/** yield model inputs come from ONE season (the one being forecast or the one harvested) */
function seasonYieldFeatures(season) {
  return {
    peak: season.peak, amplitude: season.amplitude, auc: season.auc,
    length: season.lengthDays !== null ? season.lengthDays : (season.lengthSoFar || 0),
  };
}
function yieldInput(sf) { return YIELD_FEATURE_KEYS.map((k) => (Number.isFinite(sf[k]) ? sf[k] : 0)); }

/** samples: [{features: seasonYieldFeatures(season), yield_t_per_rai, baseline}] for ONE crop */
function trainYieldModel(crop, samples) {
  const report = { crop, sample_size: samples.length };
  if (samples.length < YIELD_MODEL_MIN_SAMPLES) return { ...report, activated: false, reason: 'insufficient_data', min_samples: YIELD_MODEL_MIN_SAMPLES };
  const X = samples.map((s) => yieldInput(s.features)); const y = samples.map((s) => s.yield_t_per_rai);
  let mlApe = 0; let baseApe = 0; const resid = [];
  for (const fold of kFolds(samples.length, 5)) {
    const tr = samples.map((_, i) => i).filter((i) => !fold.includes(i));
    const st = standardizer(tr.map((i) => X[i]));
    const w = trainRidge(tr.map((i) => st.apply(X[i])), tr.map((i) => y[i]), 1);
    fold.forEach((i) => {
      const xs = st.apply(X[i]);
      const pred = Math.max(0, w[0] + xs.reduce((s, v, j) => s + v * w[j + 1], 0));
      mlApe += Math.abs(pred - y[i]) / y[i];
      resid.push((pred - y[i]) / y[i]);
      if (samples[i].baseline) baseApe += Math.abs(samples[i].baseline - y[i]) / y[i];
      else baseApe += 1;
    });
  }
  const mape = mlApe / samples.length; const baseMape = baseApe / samples.length;
  const st = standardizer(X); const w = trainRidge(X.map(st.apply), y, 1);
  const relSd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length);
  const activated = mape < baseMape;
  return {
    ...report, activated, reason: activated ? 'beats_baseline' : 'not_better_than_baseline',
    metrics: { cv_mape: round(mape, 3), baseline_mape: round(baseMape, 3), rel_sd: round(relSd, 3) },
    params: { w, means: st.means, stds: st.stds, feature_keys: YIELD_FEATURE_KEYS, rel_sd: relSd },
  };
}

function forecastYield({ crop, season, profile, areaRai, activeYieldModel }) {
  if (!crop || !profile || !profile.typical_yield_t_per_rai || !season) return null;
  const base = baselineYieldPerRai(profile, season);
  if (base === null) return null;
  let perRai = base; let method = 'baseline_ndvi_scaled'; let relSd = 0.25; let modelId = null;
  if (activeYieldModel && activeYieldModel.params) {
    const p = activeYieldModel.params;
    const xs = yieldInput(seasonYieldFeatures(season)).map((v, j) => (v - p.means[j]) / p.stds[j]);
    const pred = p.w[0] + xs.reduce((s, v, j) => s + v * p.w[j + 1], 0);
    if (Number.isFinite(pred) && pred > 0) { perRai = pred; method = 'ml_ridge'; relSd = Math.max(0.08, p.rel_sd || 0.2); modelId = activeYieldModel.model_id; }
  }
  const tons = perRai * areaRai;
  return {
    method, model_id: modelId,
    yield_t_per_rai: round(perRai, 3), tons: round(tons, 2),
    tons_low: round(tons * Math.max(0, 1 - 1.28 * relSd), 2), tons_high: round(tons * (1 + 1.28 * relSd), 2),
  };
}

// -------------------------------------------- 9. anomaly checks (AI 3)
function flag(code, severity, message_th, evidence) { return { code, severity, message_th, evidence: evidence || {} }; }

/**
 * Compares the plot's own records with what the satellite saw. Every flag
 * carries a plain-Thai message and the numbers behind it.
 */
function detectAnomalies({ unit, series, seasons, f, crop, deliveries = [], harvestStages = [], groundTruth = null, profiles = {} }) {
  const flags = [];
  const declared = commodityToCrop(unit.commodity_code);
  const lowData = f.coverage < 0.5 || series.maxGapDays > 90;
  if (lowData) {
    flags.push(flag('LOW_DATA', 'info', `ภาพดาวเทียมปลอดเมฆในรอบ 12 เดือนยังน้อย (ครอบคลุม ${Math.round(f.coverage * 100)}% ช่องว่างนานสุด ${Math.round(series.maxGapDays)} วัน) ผลตรวจข้ออื่นจึงเชื่อถือได้น้อยลง`,
      { coverage: round(f.coverage, 2), max_gap_days: Math.round(series.maxGapDays), observations: series.nObs }));
  }
  const tag = lowData ? ' (ข้อมูลภาพน้อย)' : '';

  // registered area vs drawn boundary
  if (unit.area_rai && unit.poly_area_rai) {
    const diff = Math.abs(unit.poly_area_rai - unit.area_rai) / unit.area_rai;
    if (diff > 0.15) {
      flags.push(flag('AREA_MISMATCH', diff > 0.3 ? 'high' : 'medium',
        `พื้นที่ที่ขึ้นทะเบียน ${round(unit.area_rai, 2)} ไร่ ต่างจากขอบเขตแปลงที่วาดไว้ ${round(unit.poly_area_rai, 2)} ไร่ (${Math.round(diff * 100)}%)`,
        { registered_rai: round(unit.area_rai, 2), boundary_rai: round(unit.poly_area_rai, 2) }));
    }
  }

  // declared crop vs confirmed crop vs what the satellite sees
  if (groundTruth && declared && groundTruth.crop_code !== declared) {
    flags.push(flag('CROP_MISMATCH', 'high',
      `ทะเบียนแปลงระบุเป็น${CROP_TH[declared]} แต่ได้รับการยืนยันว่าปลูก${CROP_TH[groundTruth.crop_code] || groundTruth.crop_code} — ควรแก้ไขทะเบียนแปลงให้ตรง`,
      { declared, confirmed: groundTruth.crop_code, confirmed_at: groundTruth.created_at || null }));
  } else if (declared && crop.crop && crop.crop !== declared && !groundTruth) {
    // Flag only when the declared crop itself fits badly — not merely
    // because another crop scored a little higher (rice vs maize).
    const fit = crop.scores && crop.scores[declared] !== undefined ? crop.scores[declared] : null;
    if (fit !== null && fit < 0.5) {
      flags.push(flag('CROP_MISMATCH', fit < 0.25 && !lowData ? 'high' : 'medium',
        `ทะเบียนแปลงระบุเป็น${CROP_TH[declared]} แต่รูปแบบค่า NDVI ไม่เข้ากับ${CROP_TH[declared]} (เข้ากันได้ ${Math.round(fit * 100)}%) ใกล้เคียง${CROP_TH[crop.crop]}มากกว่า (${Math.round(crop.scores[crop.crop] * 100)}%)${tag}`,
        { declared, declared_fit: round(fit, 2), predicted: crop.crop, confidence: crop.confidence, method: crop.method }));
    }
  }

  // an annual field crop with no crop cycle at all
  const effective = groundTruth ? groundTruth.crop_code : declared;
  if (ANNUAL_FIELD_CROPS.includes(effective) && f.nSeasons === 0 && f.coverage >= 0.5) {
    flags.push(flag('NO_CROP_CYCLE', 'medium',
      `ไม่พบรอบการเจริญเติบโตและเก็บเกี่ยวแบบ${CROP_TH[effective]}ในรอบ 12 เดือน (NDVI ต่ำสุด ${round(f.min, 2)} สูงสุด ${round(f.max, 2)})`,
      { min_ndvi: round(f.min, 2), max_ndvi: round(f.max, 2) }));
  }

  // deliveries vs seasons
  const profile = profiles[effective] || null;
  const valid = deliveries.filter((d) => d.status !== 'rejected');
  const seen = [];
  for (const d of valid) {
    const dd = toDay(d.delivered_at);
    if (series.firstObsDay === null || dd < series.firstObsDay || dd > series.asOfDay) continue;
    const containing = seasons.find((s) => {
      const from = s.sosDay !== null ? s.sosDay : s.peakDay - 60;
      const to = s.eosDay !== null ? s.eosDay : series.asOfDay;
      return dd >= from && dd <= to;
    });
    if (containing && (dd < containing.peakDay || (containing.eosDay === null && containing.ongoing) || (containing.eosDay !== null && dd < containing.eosDay - 20))) {
      const after = containing.eosDay !== null ? `NDVI ลดลง (เก็บเกี่ยว) ประมาณ ${dayToIso(containing.eosDay)}` : `ณ ข้อมูลล่าสุดพืชยังเขียวอยู่ (NDVI สูงสุด ${round(containing.peak, 2)} เมื่อ ${dayToIso(containing.peakDay)})`;
      flags.push(flag('DELIVERY_BEFORE_HARVEST', 'high',
        `บันทึกส่งผลผลิต ${round(Number(d.quantity_ton), 2)} ตัน วันที่ ${dayToIso(dd)} ระหว่างที่พืชในแปลงยังไม่ถึงช่วงเก็บเกี่ยว — ${after}`,
        { delivered_at: dayToIso(dd), quantity_ton: Number(d.quantity_ton), peak_date: dayToIso(containing.peakDay), harvest_date: dayToIso(containing.eosDay) }));
      continue;
    }
    const harvestNear = seasons.find((s) => s.eosDay !== null && dd >= s.eosDay - 20 && dd <= s.eosDay + 120);
    if (!harvestNear && !containing) {
      flags.push(flag('DELIVERY_WITHOUT_HARVEST', 'medium',
        `บันทึกส่งผลผลิต ${round(Number(d.quantity_ton), 2)} ตัน วันที่ ${dayToIso(dd)} แต่ไม่พบช่วงเก็บเกี่ยวในภาพดาวเทียมก่อนหน้านั้น 4 เดือน${tag}`,
        { delivered_at: dayToIso(dd), quantity_ton: Number(d.quantity_ton) }));
      continue;
    }
    if (harvestNear) seen.push({ season: harvestNear, d });
  }

  // tons per rai per harvested season
  const bySeason = new Map();
  seen.forEach(({ season, d }) => { bySeason.set(season, (bySeason.get(season) || 0) + Number(d.quantity_ton)); });
  for (const [season, tons] of bySeason) {
    const perRai = unit.area_rai ? tons / unit.area_rai : null;
    if (!perRai || !profile) continue;
    if (profile.max_yield_t_per_rai && perRai > Number(profile.max_yield_t_per_rai)) {
      flags.push(flag('YIELD_OUTLIER', 'high',
        `ส่งผลผลิตรวม ${round(tons, 2)} ตัน = ${round(perRai, 2)} ตัน/ไร่ สูงเกินกว่าที่${CROP_TH[effective]}ให้ได้ (สูงสุดประมาณ ${profile.max_yield_t_per_rai} ตัน/ไร่)`,
        { tons: round(tons, 2), t_per_rai: round(perRai, 3), max_t_per_rai: Number(profile.max_yield_t_per_rai), harvest_date: dayToIso(season.eosDay) }));
    } else {
      const base = baselineYieldPerRai(profile, season);
      if (base && perRai > base * 1.8) {
        flags.push(flag('YIELD_OUTLIER', 'medium',
          `ส่งผลผลิต ${round(perRai, 2)} ตัน/ไร่ สูงกว่าที่คาดจากค่า NDVI ของฤดูนั้น (${round(base, 2)} ตัน/ไร่) เกือบ 2 เท่า`,
          { t_per_rai: round(perRai, 3), expected_t_per_rai: round(base, 3), harvest_date: dayToIso(season.eosDay) }));
      }
    }
  }

  // harvest stage recorded vs satellite harvest
  for (const st of harvestStages) {
    if (!st.actual_date) continue;
    const ad = toDay(st.actual_date);
    if (series.firstObsDay === null || ad < series.firstObsDay || ad > series.asOfDay) continue;
    const eos = seasons.filter((s) => s.eosDay !== null).map((s) => s.eosDay);
    const nearest = eos.length ? eos.reduce((b, e) => (Math.abs(e - ad) < Math.abs(b - ad) ? e : b)) : null;
    if (nearest === null || Math.abs(nearest - ad) > 30) {
      flags.push(flag('HARVEST_DATE_MISMATCH', 'medium',
        nearest === null
          ? `บันทึกงวดเก็บเกี่ยววันที่ ${dayToIso(ad)} แต่ไม่พบการเก็บเกี่ยวในภาพดาวเทียม${tag}`
          : `บันทึกงวดเก็บเกี่ยววันที่ ${dayToIso(ad)} แต่ภาพดาวเทียมเห็นการเก็บเกี่ยวประมาณ ${dayToIso(nearest)} (ต่างกัน ${Math.round(Math.abs(nearest - ad))} วัน)`,
        { recorded: dayToIso(ad), satellite: dayToIso(nearest) }));
    }
  }

  const sev = flags.map((x) => x.severity);
  const riskLevel = sev.includes('high') ? 'high' : (sev.includes('medium') ? 'medium' : (lowData ? 'unknown' : 'low'));
  return { flags, risk_level: riskLevel };
}

// ---------------------------------------------- 10. one plot, end to end
/**
 * input: { unit:{unit_id, commodity_code, area_rai, poly_area_rai},
 *          points:[{date, ndvi}], deliveries, harvestStages, groundTruth,
 *          profiles:{crop: profileRow}, models:{crop, yield:{crop: model}},
 *          asOf:'YYYY-MM-DD' }
 */
function assessPlot(input) {
  const asOfDay = toDay(input.asOf || new Date().toISOString().slice(0, 10));
  const series = composite(input.points, asOfDay, 540);
  const seasons = detectSeasons(series);
  const f = extractFeatures(series, seasons);
  const crop = classifyCrop(f, input.models && input.models.crop);
  const gt = input.groundTruth || null;
  const declared = commodityToCrop(input.unit.commodity_code);
  const profiles = input.profiles || {};
  const anomalies = detectAnomalies({
    unit: { ...input.unit, area_rai: Number(input.unit.area_rai), poly_area_rai: input.unit.poly_area_rai ? Number(input.unit.poly_area_rai) : null },
    series, seasons, f, crop, deliveries: input.deliveries, harvestStages: input.harvestStages, groundTruth: gt, profiles,
  });
  // The crop we forecast for: the confirmed one; else the declared one
  // unless the satellite disputes it (then nothing until someone confirms).
  const disputed = !gt && anomalies.flags.some((x) => x.code === 'CROP_MISMATCH');
  const forecastCrop = gt ? gt.crop_code : (disputed ? null : (declared || (crop.confidence >= 0.6 ? crop.crop : null)));
  const profile = forecastCrop ? profiles[forecastCrop] || null : null;
  const dates = seasonDates(f, forecastCrop || crop.crop, profile || profiles[crop.crop] || null, asOfDay);
  if (dates.planting_date && f.latestSeason && f.latestSeason.sosDay !== null) {
    const i = Math.round((f.latestSeason.sosDay - series.start) / series.step);
    const seen = [i - 1, i, i + 1].some((k) => series.observed[k]);
    if (!seen) dates.planting_date_note = 'ประมาณจากช่วงที่ไม่มีภาพปลอดเมฆ';
  }
  if (dates.season_status === 'harvested') {
    const v = series.vals.filter((x) => x !== null).slice(-3);
    if (v.length === 3 && v[2] > v[0] + 0.08 && v[2] >= 0.35) dates.season_status = 'new_season_starting';
  }
  const yieldModel = forecastCrop && input.models && input.models.yield ? input.models.yield[forecastCrop] : null;
  let forecast = null;
  if (['growing', 'harvested', 'new_season_starting'].includes(dates.season_status)) {
    forecast = forecastYield({ crop: forecastCrop, season: f.latestSeason, profile, areaRai: Number(input.unit.area_rai), activeYieldModel: yieldModel });
    if (forecast) forecast.crop = forecastCrop;
  }
  const forecastNote = forecast ? null
    : (disputed ? 'ชนิดพืชในทะเบียนไม่ตรงกับภาพดาวเทียม — ให้สหกรณ์ยืนยันชนิดพืชก่อนจึงจะพยากรณ์ผลผลิต'
      : (!f.latestSeason ? 'ยังไม่พบรอบการปลูกในภาพดาวเทียม' : (profile && !profile.typical_yield_t_per_rai ? 'พืชชนิดนี้ยังไม่มีค่าผลผลิตอ้างอิง' : null)));
  const { mainSeason, latestSeason, ...plainFeatures } = f;
  return {
    as_of: dayToIso(asOfDay),
    declared_crop: declared,
    confirmed_crop: gt ? gt.crop_code : null,
    predicted_crop: crop.crop,
    crop_confidence: crop.confidence,
    crop_method: crop.method,
    crop_ambiguous: !!crop.ambiguous,
    crop_scores: Object.fromEntries(Object.entries(crop.scores || {}).map(([k, v]) => [k, round(v, 3)])),
    crop_model_id: crop.model_id || null,
    ...dates,
    forecast,
    forecast_note: forecastNote,
    flags: anomalies.flags,
    risk_level: anomalies.risk_level,
    features: Object.fromEntries(Object.entries(plainFeatures).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v])),
    seasons: seasons.map((s) => ({
      sos: dayToIso(s.sosDay), peak: dayToIso(s.peakDay), eos: dayToIso(s.eosDay), peak_ndvi: round(s.peak, 3),
      length_days: s.lengthDays !== null ? Math.round(s.lengthDays) : null, ongoing: s.ongoing,
    })),
  };
}

/** AI 4: share (0-100) of a farmer's assessed plots with no medium/high flag. */
function plotHealthFactor(assessments) {
  const judged = assessments.filter((a) => a.risk_level && a.risk_level !== 'unknown');
  if (!judged.length) return null;
  return round((100 * judged.filter((a) => a.risk_level === 'low').length) / judged.length, 2);
}

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v === undefined ? null : v;
  const k = 10 ** d; return Math.round(v * k) / k;
}

module.exports = {
  CROPS, CROP_TH, ANNUAL_FIELD_CROPS, FEATURE_KEYS,
  CROP_MODEL_MIN_SAMPLES, CROP_MODEL_MIN_PER_CLASS, YIELD_MODEL_MIN_SAMPLES,
  commodityToCrop, toDay, dayToIso,
  composite, detectSeasons, extractFeatures, ruleCropScores, pickCrop, classifyCrop,
  trainCropModel, predictCropMl, trainYieldModel, baselineYieldPerRai, seasonYieldFeatures, forecastYield,
  detectAnomalies, assessPlot, plotHealthFactor, seasonDates,
  _internal: { trainSoftmax, softmaxProbs, trainRidge, standardizer, kFolds, trap },
};
