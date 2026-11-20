/*
 * Path-by-path simulator of OpenLiquid free-mode positions on a one-touch event market.
 * Compiled by csim.py (cc -O3 -shared) and called through ctypes.
 *
 * Underlying: y = ln(B/S) > 0, dy = (sigma^2/2) dt - sigma dW, scheduled gaps y -= J, J ~ N(-s^2/2, s^2).
 * Touch (y <= 0, or a Brownian-bridge crossing inside a step) resolves YES; the contract end resolves NO.
 * Market mid = fair YES probability rounded to the 1c tick. Slow price = exponential average (tau_slow)
 * moved toward the mid that was held during the last step (the oracle's rule).
 *
 * Rules implemented per position (own side price ps; YES: ps = p, NO: ps = 1 - p), per $1 of margin:
 *   shares n = L/ps0, reserve C = min(cap_mult, (1-ps0)/ps0), result = clamp(n (ps - ps0), -1, C)
 *   fills worse-of: buy YES at max(mid, slow), sell YES at min(mid, slow)
 *   liquidation when 1 + result(mid) <= maint, settled at the mid (lat_steps later if requested), fee liq_fee
 *   collect / voluntary close when the worse-of close price yields >= take_frac * C
 *   forceClose when L > integer time limit (clock = contract end, or next scheduled gap if clock_mode = 1)
 *   crowding fee = borrowed shares * skew * (1 - ps_mid)/max(tau_end, tau_floor) per second, from profit only
 *   profit share on net profit
 */
#include <math.h>
#include <stdint.h>

#define SEC_Y (365.0 * 86400.0)
#define TICK 0.01

/* ---- parameter indices (double par[]) ---- */
enum {
  P_SIGMA, P_T, P_DELTA, P_DY, P_GAP_SD, P_MAINT, P_LIQ_FEE, P_PROFIT_FEE, P_CAP_MULT, P_H_REACT,
  P_Z_TIME, P_TAU_FLOOR, P_TAU_SLOW, P_LEV_CEIL, P_MIN_DIST, P_JUMP_TICKS, P_T0, P_DT_SEC, P_TAKE_FRAC,
  P_SKEW, P_LEV, P_THETA, P_ENTRY_EPS, P_FLAT_BEFORE, P_FLAT_AFTER, P_LEV_CAP, P_MIN_LEV, P_MAX_GAP,
  P_HALF_SPREAD, /* candidate fix: fill at the touch, i.e. half a spread worse than the worse-of price */
  P_COUNT
};
/* ---- parameter indices (int64 ipar[]) ---- */
enum {
  I_USE_CLOSED, I_N_ROWS, I_NY, I_N_GAPS, I_USE_TIME_LEV, I_CLOCK_MODE, I_JUMP_1X, I_MAX_STEPS,
  I_LAT_STEPS, I_MODE, I_SIDE, I_POLICY, I_NOUT, I_COUNT
};

typedef struct { uint64_t s[4]; int has_spare; double spare; } rng_t;

static inline uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
static inline uint64_t splitmix(uint64_t *x) {
  uint64_t z = (*x += 0x9e3779b97f4a7c15ULL);
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}
static inline uint64_t next_u64(rng_t *r) {
  uint64_t *s = r->s;
  uint64_t result = rotl(s[1] * 5, 7) * 9, t = s[1] << 17;
  s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 45);
  return result;
}
static inline double unif(rng_t *r) { return ((double)(next_u64(r) >> 11) + 0.5) * (1.0 / 9007199254740992.0); }
static inline double normal(rng_t *r) {
  if (r->has_spare) { r->has_spare = 0; return r->spare; }
  double u, v, s;
  do { u = 2.0 * unif(r) - 1.0; v = 2.0 * unif(r) - 1.0; s = u * u + v * v; } while (s >= 1.0 || s == 0.0);
  double m = sqrt(-2.0 * log(s) / s);
  r->spare = v * m; r->has_spare = 1;
  return u * m;
}
static inline double ncdf(double x) { return 0.5 * erfc(-x * 0.7071067811865476); }

typedef struct {
  int use_closed; double sigma, T, delta, dy; const double *lo, *hi; int64_t n_rows, ny;
} model_t;

static inline double no_price(const model_t *M, double y, double t) {
  if (y <= 0.0) return 0.0;
  if (M->use_closed) {
    double theta = M->T - t;
    if (theta <= 0.0) return 1.0;
    double nu = 0.5 * M->sigma * M->sigma, sd = M->sigma * sqrt(theta);
    double v = ncdf((y + nu * theta) / sd) - exp(-y) * ncdf((-y + nu * theta) / sd);
    return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v);
  }
  double x = t / M->delta;
  int64_t i = (int64_t)floor(x + 1e-9);
  double w = x - (double)i;
  if (w < 0.0) w = 0.0;
  if (i >= M->n_rows - 1) { i = M->n_rows - 1; w = 0.0; }
  double yy = y / M->dy;
  int64_t j = (int64_t)floor(yy);
  double fy;
  if (j >= M->ny - 1) { j = M->ny - 2; fy = 1.0; } else fy = yy - (double)j;
  const double *a = M->lo + i * M->ny + j;
  double va = a[0] * (1.0 - fy) + a[1] * fy;
  if (w <= 0.0) return va;
  const double *b = M->hi + i * M->ny + j;
  double vb = b[0] * (1.0 - fy) + b[1] * fy;
  return (1.0 - w) * va + w * vb;
}

static inline double round_tick(double p) { return floor(p / TICK + 0.5) * TICK; }

static inline double time_lev(const double *par, double p, double tau) {
  /* contract _timeLeverage: floor, capped at the ceiling, never below 1 */
  if (tau <= 0.0) return 1.0;
  if (p >= 1.0 || p <= 0.0) return 1.0;
  double dist = p < 1.0 - p ? p : 1.0 - p;
  double sd = sqrt(p * (1.0 - p) * par[P_H_REACT] / tau);
  double lev = floor(dist / (par[P_Z_TIME] * sd) + 1e-9);
  if (lev > par[P_LEV_CEIL]) lev = par[P_LEV_CEIL];
  if (lev < 1.0) lev = 1.0;
  return lev;
}
static inline double max_lev(const double *par, int use_time, double p, double tau) {
  double dist = p < 1.0 - p ? p : 1.0 - p;
  double lev = floor(dist / par[P_MIN_DIST] + 1e-9);
  if (lev > par[P_LEV_CEIL]) lev = par[P_LEV_CEIL];
  if (use_time) { double tl = time_lev(par, p, tau); if (tl < lev) lev = tl; }
  if (lev < 1.0) lev = 1.0;
  return lev;
}

typedef struct {
  int open, side, spanned; double ps0, L, nsh, reserve, borrowed, crowd, adj; int64_t count, entry_step;
} pos_t;

static inline void settle(const double *par, double r, double crowd_fee, int liquidated,
                          double *trader, double *house, double *lf, double *crowd_paid) {
  double c = 0.0, tr, ho;
  if (r > 0.0) {
    c = crowd_fee < r ? crowd_fee : r;
    double profit = r - c, share = profit * par[P_PROFIT_FEE];
    tr = profit - share; ho = -(profit - share);
  } else { tr = r; ho = -r; }
  double l = 0.0;
  if (liquidated) { l = par[P_LIQ_FEE]; if (l > 1.0 + tr) l = 1.0 + tr; if (l < 0.0) l = 0.0; tr -= l; }
  *trader = tr; *house = ho; *lf = l; *crowd_paid = c;
}

static inline double clampr(double raw, double reserve) {
  double r = raw < reserve ? raw : reserve;
  return r < -1.0 ? -1.0 : r;
}

void simulate(const double *par, const int64_t *ipar, const double *lo, const double *hi,
              const double *gap_t, const double *y0, int64_t n, uint64_t seed, double *out) {
  model_t M;
  M.use_closed = (int)ipar[I_USE_CLOSED]; M.sigma = par[P_SIGMA]; M.T = par[P_T];
  M.delta = par[P_DELTA]; M.dy = par[P_DY]; M.lo = lo; M.hi = hi; M.n_rows = ipar[I_N_ROWS]; M.ny = ipar[I_NY];
  const int64_t n_gaps = ipar[I_N_GAPS], max_steps = ipar[I_MAX_STEPS], lat = ipar[I_LAT_STEPS];
  const int mode = (int)ipar[I_MODE], policy = (int)ipar[I_POLICY], use_time = (int)ipar[I_USE_TIME_LEV];
  const int clock_mode = (int)ipar[I_CLOCK_MODE], jump1x = (int)ipar[I_JUMP_1X];
  const int64_t nout = ipar[I_NOUT];
  const double sigma = par[P_SIGMA], T = par[P_T], t0 = par[P_T0], dt_sec = par[P_DT_SEC];
  const double dt = dt_sec / SEC_Y, nu = 0.5 * sigma * sigma, sd = sigma * sqrt(dt), sd2 = sd * sd;
  const double decay = exp(-dt_sec / par[P_TAU_SLOW]);
  const double gap_sd = par[P_GAP_SD], maint = par[P_MAINT], take = par[P_TAKE_FRAC], skew = par[P_SKEW];
  const double flat_before = par[P_FLAT_BEFORE], flat_after = par[P_FLAT_AFTER], hs = par[P_HALF_SPREAD];

  for (int64_t i = 0; i < n; i++) {
    rng_t rng; uint64_t sm = seed + 0x632be59bd9b4e019ULL * (uint64_t)(i + 1);
    for (int k = 0; k < 4; k++) rng.s[k] = splitmix(&sm);
    rng.has_spare = 0; rng.spare = 0.0;
    double *o = out + i * nout;
    for (int64_t k = 0; k < nout; k++) o[k] = 0.0;

    double y = y0[i], t = t0;
    double f = 1.0 - no_price(&M, y, t), mid = round_tick(f), slow = mid, mid_prev = mid;
    int64_t g = 0;
    while (g < n_gaps && gap_t[g] <= t0 + 1e-12) g++;
    double last_gap_t = -1e9;
    pos_t p; p.open = 0; p.spanned = 0;
    double tot_tr = 0, tot_ho = 0, tot_lf = 0, tot_crowd = 0, tot_hold = 0, tot_r = 0;
    int64_t n_tr = 0, n_win = 0;
    int ended = 0; /* market resolved */

    if (mode == 0) {
      p.open = 1; p.side = (int)ipar[I_SIDE]; p.spanned = 0;
      double fill = p.side ? mid + hs : mid - hs; /* calm: slow = mid */
      p.ps0 = p.side ? fill : 1.0 - fill;
      double tau0 = (T - t) * SEC_Y;
      if (clock_mode == 1 && g < n_gaps) tau0 = (gap_t[g] - t) * SEC_Y;
      p.L = par[P_LEV] > 0.0 ? par[P_LEV] : max_lev(par, use_time, mid, tau0);
      p.nsh = p.L / p.ps0; p.reserve = (1.0 - p.ps0) / p.ps0;
      if (p.reserve > par[P_CAP_MULT]) p.reserve = par[P_CAP_MULT];
      p.borrowed = (p.L - 1.0) / p.ps0; p.crowd = 0.0; p.adj = 0.0; p.count = -1; p.entry_step = 0;
    }

    int64_t s = 0;
    for (s = 1; s <= max_steps; s++) {
      t = t0 + (double)s * dt;
      double z = normal(&rng);
      double ynew = y + nu * dt - sd * z;
      int hit = ynew <= 0.0;
      if (!hit && y < 8.0 * sd && ynew < 8.0 * sd) { if (unif(&rng) < exp(-2.0 * y * ynew / sd2)) hit = 1; }
      y = ynew;
      if (!hit && g < n_gaps && t >= gap_t[g] - 1e-12) {
        double J = -0.5 * gap_sd * gap_sd + gap_sd * normal(&rng);
        y -= J; if (y <= 0.0) hit = 1;
        last_gap_t = gap_t[g]; g++;
        if (p.open) p.spanned = 1;
      }
      int res_yes = hit, res_no = (!hit) && (t >= T - 1e-12);
      if (res_yes || res_no) {
        ended = 1;
        if (p.open) {
          double ps = res_yes ? (p.side ? 1.0 : 0.0) : (p.side ? 0.0 : 1.0);
          if (jump1x) { /* the final move to 0 or 1 is itself a jump for the candidate rule */
            double ps_prev = p.side ? mid_prev : 1.0 - mid_prev, d = ps - ps_prev;
            if (d > par[P_JUMP_TICKS] * TICK + 1e-12) p.adj += d;
            else if (jump1x == 2 && d < -(par[P_JUMP_TICKS] * TICK + 1e-12)) p.adj += d;
          }
          double r = clampr(p.nsh * (ps - p.ps0) - p.borrowed * p.adj, p.reserve);
          double tr, ho, lf, cp; settle(par, r, p.crowd * p.borrowed * skew, 0, &tr, &ho, &lf, &cp);
          if (mode == 0) { o[0] = r; o[1] = 2; o[2] = (double)s * dt_sec; o[3] = p.crowd * p.borrowed; o[4] = p.spanned; o[5] = tr; o[6] = ho; o[7] = lf; }
          tot_tr += tr; tot_ho += ho; tot_crowd += cp; tot_hold += (double)(s - p.entry_step) * dt_sec; tot_r += r;
          n_tr++; if (r > 0) n_win++;
          p.open = 0;
        }
        break;
      }
      f = 1.0 - no_price(&M, y, t);
      mid = round_tick(f);
      slow = mid_prev + (slow - mid_prev) * decay;
      double tau_end = (T - t) * SEC_Y;
      double tau_clk = (clock_mode == 1 && g < n_gaps) ? (gap_t[g] - t) * SEC_Y : tau_end;

      if (p.open) {
        double ps_mid = p.side ? mid : 1.0 - mid;
        double ps_close = p.side ? (mid < slow ? mid : slow) - hs : 1.0 - (mid > slow ? mid : slow) - hs;
        p.crowd += (1.0 - ps_mid) / (tau_end > par[P_TAU_FLOOR] ? tau_end : par[P_TAU_FLOOR]) * dt_sec;
        if (jump1x) {
          double ps_prev = p.side ? mid_prev : 1.0 - mid_prev, d = ps_mid - ps_prev;
          /* jump_1x = 1: only favourable jumps are stripped from the borrowed shares (winners paid 1x);
             jump_1x = 2: symmetric - the borrowed shares neither gain nor lose on a jump */
          if (d > par[P_JUMP_TICKS] * TICK + 1e-12) p.adj += d;
          else if (jump1x == 2 && d < -(par[P_JUMP_TICKS] * TICK + 1e-12)) p.adj += d;
        }
        double r_mid = clampr(p.nsh * (ps_mid - p.ps0) - p.borrowed * p.adj, p.reserve);
        int under = (1.0 + r_mid <= maint + 1e-12), liq = 0;
        if (lat == 0) liq = under;
        else if (p.count < 0) { if (under) p.count = lat; }
        else { p.count--; if (p.count == 0) { if (under) liq = 1; else p.count = -1; } }
        int kind = -1; double r = 0.0;
        if (liq) { kind = 0; r = r_mid; }
        else {
          double raw_close = p.nsh * (ps_close - p.ps0) - p.borrowed * p.adj;
          if (raw_close >= take * p.reserve - 1e-12) { kind = 1; r = clampr(raw_close, p.reserve); }
          else if (use_time && p.L > 1.0 && p.L > time_lev(par, mid, tau_clk)) { kind = 3; r = clampr(raw_close, p.reserve); }
          else if (mode == 1 && flat_before >= 0.0 && g < n_gaps && (gap_t[g] - t) * SEC_Y <= flat_before) { kind = 5; r = clampr(raw_close, p.reserve); }
        }
        if (kind >= 0) {
          double tr, ho, lf, cp; settle(par, r, p.crowd * p.borrowed * skew, kind == 0, &tr, &ho, &lf, &cp);
          if (mode == 0) { o[0] = r; o[1] = kind; o[2] = (double)s * dt_sec; o[3] = p.crowd * p.borrowed; o[4] = p.spanned; o[5] = tr; o[6] = ho; o[7] = lf; }
          tot_tr += tr; tot_ho += ho; tot_lf += lf; tot_crowd += cp; tot_hold += (double)(s - p.entry_step) * dt_sec; tot_r += r;
          n_tr++; if (r > 0) n_win++;
          p.open = 0;
          if (mode == 0) { mid_prev = mid; break; }
        }
      } else if (mode == 1) {
        int ok = 1;
        if (flat_before >= 0.0 && g < n_gaps && (gap_t[g] - t) * SEC_Y <= flat_before) ok = 0;
        if (flat_after >= 0.0 && (t - last_gap_t) * SEC_Y < flat_after) ok = 0;
        if (mid < 0.01 - 1e-12 || mid > 0.99 + 1e-12) ok = 0;
        double gapv = fabs(mid - slow);
        if (gapv > par[P_MAX_GAP]) ok = 0;
        int side = -1;
        if (ok) {
          if (policy == 0) side = 0;
          else if (policy == 1) side = 1;
          else if (policy == 2) side = (mid <= 0.5) ? 1 : 0;
          else if (policy == 4) side = (mid <= 0.5) ? 0 : 1;
          else if (policy == 3) { double d = f - mid; if (d >= par[P_THETA]) side = 1; else if (d <= -par[P_THETA]) side = 0; }
        }
        if (side >= 0) {
          double fill_yes = side ? (mid > slow ? mid : slow) + hs : (mid < slow ? mid : slow) - hs;
          double pen = fabs(fill_yes - mid) - hs;
          double L = max_lev(par, use_time, mid, tau_clk);
          if (par[P_LEV_CAP] > 0.0 && L > par[P_LEV_CAP]) L = par[P_LEV_CAP];
          if (pen <= par[P_ENTRY_EPS] + 1e-15 && L >= par[P_MIN_LEV]) {
            p.open = 1; p.side = side; p.spanned = 0; p.L = L;
            p.ps0 = side ? fill_yes : 1.0 - fill_yes;
            p.nsh = L / p.ps0; p.reserve = (1.0 - p.ps0) / p.ps0;
            if (p.reserve > par[P_CAP_MULT]) p.reserve = par[P_CAP_MULT];
            p.borrowed = (L - 1.0) / p.ps0; p.crowd = 0.0; p.adj = 0.0; p.count = -1; p.entry_step = s;
          }
        }
      }
      mid_prev = mid;
    }
    if (p.open) { /* horizon reached: close at the worse-of price */
      double ps_close = p.side ? (mid < slow ? mid : slow) - hs : 1.0 - (mid > slow ? mid : slow) - hs;
      double r = clampr(p.nsh * (ps_close - p.ps0) - p.borrowed * p.adj, p.reserve);
      double tr, ho, lf, cp; settle(par, r, p.crowd * p.borrowed * skew, 0, &tr, &ho, &lf, &cp);
      int64_t se = s > max_steps ? max_steps : s;
      if (mode == 0) { o[0] = r; o[1] = 4; o[2] = (double)se * dt_sec; o[3] = p.crowd * p.borrowed; o[4] = p.spanned; o[5] = tr; o[6] = ho; o[7] = lf; }
      tot_tr += tr; tot_ho += ho; tot_crowd += cp; tot_hold += (double)(se - p.entry_step) * dt_sec; tot_r += r;
      n_tr++; if (r > 0) n_win++;
    }
    if (mode == 1) {
      o[0] = tot_tr; o[1] = tot_ho; o[2] = (double)n_tr; o[3] = (double)n_win; o[4] = tot_lf; o[5] = tot_crowd;
      o[6] = tot_hold; o[7] = (double)ended; o[8] = tot_r; o[9] = (double)(s > max_steps ? max_steps : s) * dt_sec;
    }
  }
}
