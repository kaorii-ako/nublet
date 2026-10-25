import {Spring, springParams} from './spring.js';

function assert(ok, message) {
    if (!ok)
        throw new Error(`FAIL: ${message}`);
}

function run(params, hz = 120, seconds = 2, from = 0, to = 100) {
    const spring = new Spring(from);
    spring.target = to;
    let peak = from;
    let settledAt = null;
    for (let i = 1; i <= hz * seconds; i++) {
        spring.step(1 / hz, params);
        peak = Math.max(peak, spring.value);
        if (settledAt === null && spring.settled)
            settledAt = i / hz;
    }
    return {spring, peak, settledAt};
}

const critical = springParams(0.28, 1);
const open = springParams(0.32, 0.8);

const close = run(critical);
assert(close.peak <= 100.05, `critically damped spring never overshoots (peak ${close.peak.toFixed(3)})`);
assert(close.settledAt !== null && close.settledAt < 0.6, `close settles fast (got ${close.settledAt})`);

const opening = run(open);
assert(opening.peak > 100.5 && opening.peak < 103, `open has a small bounce (peak ${opening.peak.toFixed(2)})`);
assert(opening.settledAt !== null && opening.settledAt < 1, `open settles within 1s (got ${opening.settledAt})`);

const at120 = run(open, 120, 0.1);
const at60 = run(open, 60, 0.1);
assert(Math.abs(at120.spring.value - at60.spring.value) < 0.5,
    `frame-rate independent (${at120.spring.value.toFixed(2)} vs ${at60.spring.value.toFixed(2)})`);

const stalled = new Spring(0);
stalled.target = 100;
stalled.step(5, open);
assert(Number.isFinite(stalled.value) && stalled.value < 100, 'a long frame stall is clamped');

const interrupted = new Spring(0);
interrupted.target = 100;
for (let i = 0; i < 6; i++)
    interrupted.step(1 / 120, open);
interrupted.target = 0;
interrupted.step(1 / 120, critical);
assert(interrupted.velocity > 0, 'retargeting keeps momentum');

const bump = new Spring(1, 0.0005);
bump.velocity = 1.5;
let bumpPeak = 1;
for (let i = 0; i < 240 && !(i > 10 && bump.settled); i++) {
    bump.step(1 / 120, springParams(0.32, 0.55));
    bumpPeak = Math.max(bumpPeak, bump.value);
}
assert(bumpPeak > 1.03 && bumpPeak < 1.05, `alert bump peaks near 1.04 (peak ${bumpPeak.toFixed(4)})`);
assert(bump.settled, 'alert bump settles back to rest');

const fine = new Spring(1, 0.0005);
fine.target = 0.97;
assert(!fine.settled, 'a fine-precision spring does not settle on a small scale change');

print('spring: all checks passed');
