// Opt-out keyword matching.
//
// Two real customers were missed by the old start-only check inside twenty-
// four hours — "Selling a vehicle. STOP" and "Actually....STOP." — and
// neither was unsubscribed. Both cases are pinned below so they cannot
// regress. The false-positive cases matter just as much: opting a live
// customer out by mistake costs a deal, so a bare "stop" mid-sentence must
// never match.
const path = require('path');
const { isOptOutKeyword } = require(path.join(__dirname, '..', 'lib', 'helpers'));

const CASES = [
  // --- must opt out -------------------------------------------------
  ['stop', true],
  ['STOP', true],
  ['Stop .', true],
  ['  stop  ', true],
  ['stop please', true],
  ['STOPALL', true],
  ['please unsubscribe me', true],
  ['UNSUBSCRIBE', true],
  ['please stop', true],
  ['no thanks, stop', true],
  ['Selling a vehicle. STOP', true],      // real: Gabe, 2026-10-27
  ['Actually....STOP.', true],            // real: Edward, 2026-10-28
  ['Not interested. Stop!', true],

  // --- must NOT opt out ---------------------------------------------
  ['no need to stop', false],
  ['I will stop by the dealership', false],
  ['can you stop in tomorrow', false],
  ['we can stop at the bank first', false],
  ['I can stop in after work tomorrow', false],
  ['yes still looking', false],
  ['Text', false],
  ['Looking for a low km red vw beetle.', false],
  ['Yes but I don’t want to loan money fir it.', false],
  ['', false],
  [null, false],
  [undefined, false],
];

let pass = 0, fail = 0;
for (const [msg, want] of CASES) {
  const got = isOptOutKeyword(msg);
  const ok = got === want;
  if (ok) { pass++; console.log('  PASS  ' + JSON.stringify(msg) + ' -> ' + got); }
  else    { fail++; console.log('  FAIL  ' + JSON.stringify(msg) + ' -> ' + got + ' (want ' + want + ')'); }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
