#!/bin/zsh
cd .
(python3 -u s5_mc_fee_evasion.py 200000 P 1800 > s5_P.log 2>&1; echo done > s5_P.flag) &
(python3 -u s5_mc_fee_evasion.py 200000 Z 1800 > s5_Z.log 2>&1; echo done > s5_Z.flag) &
(python3 -u s4_mc_football.py 200000 C 20 > s4_C.log 2>&1; python3 -u s4_mc_football.py 200000 A 20 > s4_A.log 2>&1; echo done > s4_CA.flag) &
(python3 -u s4_mc_football.py 200000 B 20 > s4_B.log 2>&1; echo done > s4_B.flag) &
wait
