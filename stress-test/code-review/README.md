# Code-review reproductions

These are the test files the six review agents and their verifiers wrote against the contracts
as they stood before the fixes. Each one reproduces a finding, and most were written to fail
until the defect was fixed.

They are kept here as the record of what was found. They are not part of `npx hardhat test`:
the fixes changed the engine's interface (several getters were removed and the market
configuration gained fields), and these files have not been ported to it. The behaviour each
one asked for is covered, where it was fixed, by the tests in `contracts/test/`.
