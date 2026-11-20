"""
One-touch probability surface for "Will the underlying trade at or above B before T?".

Underlying: d ln S = -sigma^2/2 dt + sigma dW  (driftless GBM, r = q = 0, trades 24/7: simplification)
plus scheduled gaps (earnings) at known times: ln S += J, J ~ N(-s^2/2, s^2).
A gap that carries S to or above B is a touch.

State: y = ln(B/S) > 0 (distance to the barrier in log units), t in years from listing.
NO price  no(y,t) = P(no touch in [t,T] | y_t = y, not yet touched)   (the market's mid is assumed
to be this fair value, later rounded to the 1c tick).  YES = 1 - NO.

Between gaps:  no(y,t-d) = int_0^inf q(y,z;d) no(z,t) dz  with the killed (absorbed at 0) density of
y (drift nu = sigma^2/2, vol sigma):
   q(y,z;d) = [phi((z-y-nu d)/(sig sqrt d)) - exp(-2 nu y/sig^2) phi((z+y-nu d)/(sig sqrt d))]/(sig sqrt d)
At a gap:      no_pre(y) = E_J[ 1{y-J>0} no_post(y-J) ].
After the last gap the closed form is used.
"""
import numpy as np
from scipy.special import ndtr

SEC_PER_YEAR = 365.0 * 86400.0


def phi(x):
    return np.exp(-0.5 * x * x) / np.sqrt(2 * np.pi)


def no_closed(y, theta, sigma):
    """NO price (survival prob) for pure GBM, time left theta (years), y = ln(B/S) >= 0."""
    y = np.asarray(y, dtype=float)
    theta = np.maximum(theta, 1e-14)
    nu = 0.5 * sigma * sigma
    sd = sigma * np.sqrt(theta)
    out = ndtr((y + nu * theta) / sd) - np.exp(-y) * ndtr((-y + nu * theta) / sd)
    return np.where(y <= 0, 0.0, np.clip(out, 0.0, 1.0))


def dno_dy_closed(y, theta, sigma, eps=1e-6):
    return (no_closed(y + eps, theta, sigma) - no_closed(np.maximum(y - eps, 0), theta, sigma)) / (
        y + eps - np.maximum(y - eps, 0)
    )


class OneTouch:
    def __init__(
        self,
        sigma=0.40,
        T_days=365.0,
        gap_days=(45.0, 136.0, 227.0, 318.0),
        gap_sd=0.07,
        step_hours=3.0,
        dy=0.001,
        y_max=2.4,
    ):
        self.sigma = sigma
        self.nu = 0.5 * sigma * sigma
        self.T = T_days / 365.0
        self.gap_sd = gap_sd
        self.delta = step_hours / (365.0 * 24.0)
        self.n_t = int(round(self.T / self.delta))
        assert abs(self.n_t * self.delta - self.T) < 1e-12
        self.y = np.arange(0.0, y_max + 0.5 * dy, dy)
        self.dy = dy
        self.ny = len(self.y)
        self.gap_idx = []
        for g in gap_days:
            i = int(round(g / 365.0 / self.delta))
            assert abs(i * self.delta - g / 365.0) < 1e-12, "gap must sit on the time grid"
            self.gap_idx.append(i)
        self.gap_idx = sorted(self.gap_idx)
        self.gap_t = [i * self.delta for i in self.gap_idx]
        self._build()

    # ---- operators -----------------------------------------------------------------------
    def _diffusion_kernel(self, d):
        """K @ g + tail  ~=  int_0^ymax q(y,z;d) g(z) dz + P(Y_d > ymax, no hit) * 1, for g(0) = 0.
        With g(0) = 0 the integrand and its first derivative vanish at z = 0 (q(y,0) = 0), so the
        trapezoid rule has no O(dy^2) boundary error."""
        y = self.y
        sd = self.sigma * np.sqrt(d)
        Y0 = y[:, None]
        Z = y[None, :]
        K = (phi((Z - Y0 - self.nu * d) / sd) - np.exp(-Y0) * phi((Z + Y0 - self.nu * d) / sd)) / sd
        K = np.maximum(K, 0.0) * self.dy
        K[:, -1] *= 0.5
        ym = y[-1]
        tail = (1.0 - ndtr((ym - y - self.nu * d) / sd)) - np.exp(-y) * (1.0 - ndtr((ym + y - self.nu * d) / sd))
        # Euler-Maclaurin end term at z = ymax (g is flat there): int = T - dy^2/12 * q_z(y, ymax) * g(ymax)
        a = (ym - y - self.nu * d) / sd
        b = (ym + y - self.nu * d) / sd
        dq = (-a * phi(a) + np.exp(-y) * b * phi(b)) / (sd * sd)
        tail = tail - (self.dy**2 / 12.0) * dq
        tail[0] = 0.0
        return K, tail

    def _gap_kernel(self):
        """G @ g + corr * g'(0) + tail ~= E_J[1{y-J>0} g(y-J)] for g(0) = 0 (Euler-Maclaurin end term)."""
        y = self.y
        s = self.gap_sd
        Y0 = y[:, None]
        Z = y[None, :]
        G = phi((Z - Y0 - 0.5 * s * s) / s) / s * self.dy
        G[:, -1] *= 0.5
        corr = (self.dy**2 / 12.0) * phi((0.0 - y - 0.5 * s * s) / s) / s
        tail = 1.0 - ndtr((y[-1] - y - 0.5 * s * s) / s)
        return G, corr, tail

    def _build(self):
        n_t, ny = self.n_t, self.ny
        self.no = np.empty((n_t + 1, ny), dtype=np.float64)  # value just AFTER any gap at that index
        self.no_pre = {}  # gap index -> value just BEFORE the gap
        last_gap = self.gap_idx[-1] if self.gap_idx else -1
        # closed form after the last gap
        for i in range(n_t, last_gap - 1 if last_gap >= 0 else -1, -1):
            if i < 0:
                break
            theta = self.T - i * self.delta
            if theta <= 0:
                row = np.ones(ny)
                row[0] = 0.0
            else:
                row = no_closed(self.y, theta, self.sigma)
            self.no[i] = row
        if last_gap < 0:
            return
        K, tailK = self._diffusion_kernel(self.delta)
        G, corrG, tailG = self._gap_kernel()
        i = last_gap
        while i >= 0:
            if i in self.gap_idx:
                post = self.no[i]
                slope0 = (-3.0 * post[0] + 4.0 * post[1] - post[2]) / (2.0 * self.dy)
                pre = G @ post + corrG * slope0 + tailG * post[-1]
                # Just before a gap the NO price does NOT go to 0 as y -> 0+ (the gap can go down), so
                # pre[0] holds the right-limit; y <= 0 itself (touched) is handled by the caller.
                pre = np.clip(pre, 0.0, 1.0)
                self.no_pre[i] = pre
                upper = pre
            else:
                upper = self.no[i]
            if i == 0:
                break
            row = K @ upper + tailK * upper[-1]
            row[0] = 0.0
            self.no[i - 1] = np.clip(row, 0.0, 1.0)
            i -= 1

    # ---- evaluation ----------------------------------------------------------------------
    def row(self, t):
        """NO price as a function of the y grid at time t (years). Just after a gap if t is a gap time."""
        if t >= self.T:
            r = np.ones(self.ny)
            r[0] = 0.0
            return r
        x = t / self.delta
        i = int(np.floor(x + 1e-12))
        w = x - i
        if w < 1e-12:
            return self.no[i]
        upper = self.no_pre[i + 1] if (i + 1) in self.no_pre else self.no[i + 1]
        return (1.0 - w) * self.no[i] + w * upper

    def row_pre(self, gap_k):
        return self.no_pre[self.gap_idx[gap_k]]

    def max_yes_pre(self, gap_k):
        """Highest YES price that can exist just before gap k (S just below the barrier)."""
        return 1.0 - self.no_pre[self.gap_idx[gap_k]][0]

    def row_post(self, gap_k):
        return self.no[self.gap_idx[gap_k]]

    @staticmethod
    def interp(row, ygrid, y):
        return np.interp(y, ygrid, row)

    def yes(self, y, t):
        return 1.0 - np.interp(y, self.y, self.row(t))

    def y_from_yes(self, p_yes, row):
        """Invert a NO row (increasing in y) for the y at which YES = p_yes."""
        return np.interp(1.0 - np.asarray(p_yes), row, self.y)


if __name__ == "__main__":
    import time

    # 1) kernel stepping vs closed form, pure GBM: start from the closed form 5 days before the end
    #    and step back to day 0 with the 3-hour kernel (2,880 steps).
    t0 = time.time()
    m0 = OneTouch(sigma=0.40, T_days=365, gap_days=(), gap_sd=0.07, step_hours=3.0)
    K, tailK = m0._diffusion_kernel(m0.delta)
    i = m0.n_t - 40
    row = no_closed(m0.y, m0.T - i * m0.delta, 0.40)
    while i > 0:
        row = K @ row + tailK * row[-1]
        row[0] = 0.0
        i -= 1
        if i in (2400, 720, 0):
            ex = no_closed(m0.y, m0.T - i * m0.delta, 0.40)
            k = np.argmax(np.abs(row - ex))
            print("  kernel stepping, day %5.1f: max |grid - closed form| = %.2e at y=%.3f (NO=%.4f)"
                  % (i * m0.delta * 365, np.abs(row - ex).max(), m0.y[k], ex[k]))
    print("  (%.1fs)" % (time.time() - t0))

    # 2) full model vs brute-force MC of the touch probability
    t0 = time.time()
    m = OneTouch()
    print("build (4 earnings gaps, sd 7%%) %.1fs" % (time.time() - t0))
    rng = np.random.default_rng(1)
    npaths = 400_000
    for S_over_B, day in ((0.95, 0.0), (0.80, 0.0), (0.60, 0.0), (0.95, 44.0), (0.90, 200.0)):
        y0 = -np.log(S_over_B)
        t = day / 365.0
        p_grid = float(m.yes(np.array([y0]), t)[0])
        # MC: jump between event times exactly (survival via exact one-touch prob on each segment)
        y = np.full(npaths, y0)
        alive = np.ones(npaths, dtype=bool)
        times = [g for g in m.gap_t if g > t + 1e-12] + [m.T]
        cur = t
        for k, tn in enumerate(times):
            d = tn - cur
            sd = m.sigma * np.sqrt(d)
            z = rng.standard_normal(npaths)
            ynew = y + m.nu * d - sd * z
            u = rng.random(npaths)
            hit = (ynew <= 0) | (u < np.exp(-2.0 * y * np.maximum(ynew, 0) / (sd * sd)))
            alive &= ~hit
            y = np.maximum(ynew, 1e-12)
            if k < len(times) - 1:
                J = rng.normal(-0.5 * m.gap_sd**2, m.gap_sd, npaths)
                y = y - J
                alive &= y > 0
                y = np.maximum(y, 1e-12)
            cur = tn
        p_mc = 1.0 - alive.mean()
        se = np.sqrt(p_mc * (1 - p_mc) / npaths)
        print("  S/B=%.2f day %5.1f  YES grid=%.4f  MC=%.4f +/- %.4f  (pure-GBM closed form with sigma only: %.4f)"
              % (S_over_B, day, p_grid, p_mc, se, 1 - no_closed(np.array([y0]), m.T - t, m.sigma)[0]))
