"""
Partial skew: who pays when other traders hold leveraged positions on the opposite (YES) side?
Continuous price, constant hazard, tau0 = 30 d, everybody at the E3 maximum leverage, fees collected
in full (hold-to-cap, no evasion).  x = B_YES / B_NO (borrowed shares), so skewFrac_NO = 1 - x.

NO harvester  : first hold-to-cap round from analytic.chain (EV and expected time in position).
YES leveraged : price 1-p_NO drifts down; liquidated at 80% of the stop distance (trader keeps 15% of
                margin, liquidator 5%); if the event happens first the position is paid its cap
                C_Y = M (1-p_Y)/p_Y (less the 10% profit share).  It pays no crowding fee (uncrowded).
House rate    : -(NO rate) - m_Y * (YES rate + liquidator leakage), per $1 of NO margin per day, where
                m_Y is the YES margin that carries x times the NO side's borrowed shares.
Self-hedge    : the attacker holds both legs himself: NO rate + m_Y * YES rate.
"""
import math
from analytic import chain, lmax, DAY

T = 30 * DAY
print(" p_NO    x   skewFrac  NO harvester   YES lev. trader   YES margin   house EV      self-hedged attacker")
print("                       EV per $-day   EV per $-day      per $1 NO    per $1 NO-day EV per $1 NO-day")
for pN in [0.5, 0.7, 0.9]:
    lam = -math.log(pN) / T
    pY = 1 - pN
    LY = lmax(pY, T)
    pliq = pY * (1 - 0.8 / LY)
    pNstar = 1 - pliq
    tstar = math.log(pNstar / pN) / lam
    psurv = pN / pNstar
    CY = (1 - pY) / pY
    evY = (1 - psurv) * 0.9 * CY - psurv * 0.85
    timeY = (1 - math.exp(-lam * tstar)) / lam / DAY
    rateY = evY / timeY
    liqleak = psurv * 0.05 / timeY
    LN = lmax(pN, T)
    for x in [0.0, 0.1, 0.25, 0.5, 0.75, 1.0]:
        sf = 1 - x
        r = chain(pN, T, 1e12, sf=sf, first_only=True)
        rateN = r["rate"]
        mY = x * ((LN - 1) / pN) / ((LY - 1) / pY)
        house = -rateN - mY * (rateY + liqleak)
        print(f" {pN:4.2f}  {x:4.2f}   {sf:4.2f}     {rateN:+9.5f}      {rateY:+9.5f}        {mY:7.4f}    {house:+9.5f}       {rateN + mY*rateY:+9.5f}")
    print()
