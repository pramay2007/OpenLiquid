"""Supplementary closed-form numbers quoted in the report."""
import math
from analytic import rho, lmax, DAY

print("1. Break-even front-loading factor phi* = hazard now / average remaining hazard at which the")
print("   hold-to-cap harvest is zero-EV with E4 fully collected at skewFrac = 1:")
print("   phi* = 0.9 (L-1) rho / (0.9 L - 1)   (continuous-price rate identity)")
for p in [0.2, 0.5, 0.7, 0.8, 0.9, 0.95]:
    L = lmax(p, 30 * DAY)
    print(f"   p_s={p:4.2f}  L={L:5.2f}  rho={rho(p):5.3f}  phi*={0.9*(L-1)*rho(p)/(0.9*L-1):5.3f}")

print("\n2. Cost of E4 to an honest crowded-side trader (skewFrac = 1): the accrued fee equals the whole")
print("   capped profit C after tau/(L-1) (price roughly unchanged), whatever the market type:")
for tau_h, L in [(6, 3), (24, 5), (48, 10), (72, 10), (168, 10), (168, 25), (720, 5), (720, 25)]:
    print(f"   tau = {tau_h:4d} h, L = {L:2d}:  fee = C after {tau_h/(L-1):6.1f} h;  fee per hour = "
          f"{100*(L-1)*0.5/0.5/tau_h:5.2f}% of margin at p=0.5")

print("\n3. House loss per $1 of harvested notional per day ~ 0.9*lambda*(1-1/L) - lambda/L (no fee):")
for Td, p in [(30, 0.5), (30, 0.2), (30, 0.9), (7, 0.5), (3, 0.5), (1, 0.5)]:
    lam = -math.log(p) / Td
    L = lmax(p, Td * DAY)
    print(f"   tau0={Td:2d}d p_s={p:4.2f} L={L:5.2f} hazard={100*lam:6.2f}%/day  loss/notional/day={100*lam*(0.9*L-1)/L:6.2f}%"
          f"   expected loss over the market's life ~ {100*(1-p)*(0.9-1/L):4.1f}% of notional kept at capacity")
