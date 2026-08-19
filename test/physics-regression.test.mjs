import assert from 'node:assert/strict';
import test from 'node:test';
import { PHYSICS, resolveCircleImpact, resolveCircularBoundary, stepDropPhysics } from '../physics.js';
import { LAUNCH_MAXIMUM_SPEED, simulateShot } from '../simulation.js';

const pins = [];
[
  { count: 12, x: 238, y: 466 },
  { count: 13, x: 217, y: 503 },
  { count: 14, x: 196, y: 540 },
].forEach((row) => {
  for (let column = 0; column < row.count; column += 1) pins.push({ x: row.x + column * 42, y: row.y, r: 9 });
});
const catcherSegments = [];
for (let divider = 0; divider <= 14; divider += 1) {
  const x = 173 + divider * 42;
  catcherSegments.push(
    { ax: x, ay: 603, bx: x - 10, by: 625, catcher: true, group: divider },
    { ax: x, ay: 603, bx: x + 10, by: 625, catcher: true, group: divider },
  );
}

test('free trajectories finish without stalls, teleports or velocity outliers', () => {
  const dt = 1 / 120;
  for (let channel = 0; channel < 14; channel += 1) {
    const targetX = 173 + 42 * (channel + .5);
    for (let variant = 0; variant < 25; variant += 1) {
      const jitter = -8 + variant * (16 / 24);
      const ball = {
        x: 584,
        y: 428,
        vx: Math.max(-PHYSICS.maxHorizontalSpeed, Math.min(PHYSICS.maxHorizontalSpeed, (targetX - 584) * 1.52 + jitter * .75)),
        vy: 88 + variant * (18 / 24),
        r: 8.5,
        stallTime: 0,
        seed: `drop:${channel}:${variant}`,
      };

      let elapsed = 0;
      let largestStep = 0;
      let stationaryTime = 0;
      let longestStationaryTime = 0;
      while (ball.y <= PHYSICS.maskEntryY && elapsed < 4) {
        const result = stepDropPhysics(ball, dt, pins, catcherSegments);
        const stepDistance = Math.hypot(result.deltaX, result.deltaY);
        largestStep = Math.max(largestStep, stepDistance);
        stationaryTime = stepDistance < .12 ? stationaryTime + dt : 0;
        longestStationaryTime = Math.max(longestStationaryTime, stationaryTime);
        assert.ok(Math.abs(ball.vx) <= PHYSICS.maxHorizontalSpeed + 1e-9);
        assert.ok(ball.vy <= PHYSICS.maxDownwardSpeed + 1e-9);
        assert.ok(ball.vy >= -PHYSICS.maxUpwardSpeed - 1e-9);
        assert.ok(Number.isFinite(ball.x) && Number.isFinite(ball.y));
        elapsed += dt;
      }

      assert.ok(ball.y > PHYSICS.maskEntryY, `channel ${channel}, variant ${variant} stalled for ${elapsed.toFixed(2)}s`);
      assert.ok(elapsed < 4, `channel ${channel}, variant ${variant} took ${elapsed.toFixed(2)}s`);
      assert.ok(longestStationaryTime < .5, `channel ${channel}, variant ${variant} stopped for ${longestStationaryTime.toFixed(2)}s`);
      assert.ok(largestStep < 9, `channel ${channel}, variant ${variant} jumped ${largestStep.toFixed(2)}px in one step`);
    }
  }
});

test('a perfectly centered low-speed pin contact rolls free', () => {
  const targetX = 390;
  const pin = { x: 390, y: 503, r: 9 };
  const ball = { x: 390, y: 503 - 17.5, vx: 0, vy: 0, r: 8.5, seed: 'centred-contact' };
  let elapsed = 0;
  while (ball.y < 520 && elapsed < 1.5) {
    stepDropPhysics(ball, 1 / 120, [pin]);
    elapsed += 1 / 120;
  }
  assert.ok(ball.y >= 520, `centered contact did not roll free after ${elapsed.toFixed(2)}s`);
});

test('the leftmost pin cannot wedge the ball against an invisible side wall', () => {
  const ball = { x: 191.5, y: 522.5, vx: 0, vy: 0, r: 8.5, seed: 'outer-contact' };
  const pin = { x: 196, y: 540, r: 9 };
  let elapsed = 0;
  while (ball.y < 550 && elapsed < 1.5) {
    stepDropPhysics(ball, 1 / 120, [pin]);
    elapsed += 1 / 120;
  }
  assert.ok(ball.y >= 550, `outer pin contact remained wedged after ${elapsed.toFixed(2)}s`);
  assert.ok(ball.x < 191.5, 'ball was prevented from rolling around the pin');
});

test('the same seed reproduces the complete trajectory', () => {
  const first = { x: 584, y: 428, vx: -392, vy: 95, r: 8.5, seed: 'repeatable' };
  const second = structuredClone(first);
  for (let step = 0; step < 180; step += 1) {
    stepDropPhysics(first, 1 / 120, pins, catcherSegments);
    stepDropPhysics(second, 1 / 120, pins, catcherSegments);
  }
  assert.deepEqual(first, second);
});

test('a nail reflects the normal velocity without adding kinetic energy', () => {
  const dt = 1 / 120;
  const ball = { x: 283, y: 300, vx: 125, vy: 0, r: 8.5, escapeDirection: -1 };
  const predictedVx = ball.vx * Math.exp(-PHYSICS.airDrag * dt);
  const predictedVy = (ball.vy + PHYSICS.gravity * dt) * Math.exp(-PHYSICS.airDrag * dt);
  const incomingSpeed = Math.hypot(predictedVx, predictedVy);
  const result = stepDropPhysics(ball, dt, [{ x: 300, y: 300, r: 9 }]);
  assert.equal(result.impacts.length, 1);
  assert.ok(ball.vx < 0, `normal velocity did not reflect: vx=${ball.vx}`);
  assert.ok(Math.hypot(ball.vx, ball.vy) <= incomingSpeed + 1e-9, 'collision added kinetic energy');
});

test('a catcher tooth reflects along its visible diagonal face', () => {
  const ball = { x: 312.5, y: 307.6, vx: -80, vy: 100, r: 8.5, escapeDirection: 1 };
  const toothFace = { ax: 300, ay: 300, bx: 310, by: 322, catcher: true, group: 0 };
  const result = stepDropPhysics(ball, 1 / 120, [], [toothFace]);
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].catcher, true);
  assert.ok(ball.vx > 0, `diagonal tooth did not reflect horizontally: vx=${ball.vx}`);
});

test('the upper right rubber bumper rebounds strongly without adding energy', () => {
  const incoming = { vx: 900, vy: 825 };
  const normal = { x: 616 - 633, y: 393 - 417 };
  const before = Math.hypot(incoming.vx, incoming.vy);
  const outgoing = resolveCircleImpact(incoming.vx, incoming.vy, normal.x, normal.y, .88, .085);
  assert.ok(outgoing.vx < 0, `bumper did not redirect left: vx=${outgoing.vx}`);
  assert.ok(outgoing.vy < 0, `bumper did not redirect upward: vy=${outgoing.vy}`);
  assert.ok(Math.hypot(outgoing.vx, outgoing.vy) > before * .75, 'rubber rebound was too weak');
  assert.ok(Math.hypot(outgoing.vx, outgoing.vy) <= before + 1e-9, 'bumper added kinetic energy');
});

test('the circular playfield boundary cannot be crossed outward', () => {
  const ball = { x: 0, y: -12, vx: 30, vy: -240 };
  const before = Math.hypot(ball.vx, ball.vy);
  assert.equal(resolveCircularBoundary(ball, 0, 0, 10, .4, .04), true);
  assert.ok(Math.hypot(ball.x, ball.y) <= 10 + 1e-9);
  assert.ok(ball.vy > 0, `outward velocity was not reflected: vy=${ball.vy}`);
  assert.ok(Math.hypot(ball.vx, ball.vy) <= before + 1e-9, 'boundary added kinetic energy');
});

test('seeded full shots are deterministic and reach a physical channel', () => {
  for (let index = 0; index < 50; index += 1) {
    const seed = `full-shot:${index}`;
    const first = simulateShot(seed, LAUNCH_MAXIMUM_SPEED);
    const second = simulateShot(seed, LAUNCH_MAXIMUM_SPEED);
    assert.deepEqual(first, second);
    assert.ok(Number.isInteger(first.channel), `seed ${seed} did not reach a channel`);
    assert.ok(first.channel >= 0 && first.channel < 14);
  }
});
