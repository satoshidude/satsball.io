import {
  channelAtSlotRow,
  PHYSICS,
  resolveBallImpact,
  resolveCircularBoundary,
  stepDropPhysics,
  surfaceVariation,
} from './physics.js';

export const pins = [];
[
  { count: 12, x: 238, y: 466 },
  { count: 13, x: 217, y: 503 },
  { count: 14, x: 196, y: 540 },
].forEach((row) => {
  for (let column = 0; column < row.count; column += 1) pins.push({ x: row.x + column * 42, y: row.y, r: 9 });
});

export const catcherSegments = [];
for (let divider = 0; divider <= 14; divider += 1) {
  const x = 173 + divider * 42;
  catcherSegments.push(
    { ax: x, ay: 603, bx: x - 10, by: 625, catcher: true, group: divider },
    { ax: x, ay: 603, bx: x + 10, by: 625, catcher: true, group: divider },
  );
}

const measuredRailPath = [
  [660,1080], [648,1083], [636,1085], [608,1070], [534,1055],
  [483,1040], [429,1025], [379,1010], [336,995], [273,970],
  [184,890], [150,840], [130,790], [118,740], [113,690], [117,640],
  [130,590], [153,540], [184,490], [231,440], [293,397], [353,370],
  [393,361], [433,356], [473,356], [513,361], [553,372], [585,382],
  [604,382], [616,393],
].map(([x, y]) => ({ x, y }));

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: .5 * ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: .5 * ((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
  };
}

export const railPath = measuredRailPath.slice(0, 17);
for (let index = 17; index < measuredRailPath.length - 1; index += 1) {
  const p0 = measuredRailPath[Math.max(0, index - 1)];
  const p1 = measuredRailPath[index];
  const p2 = measuredRailPath[index + 1];
  const p3 = measuredRailPath[Math.min(measuredRailPath.length - 1, index + 2)];
  for (let step = 0; step < 8; step += 1) {
    const point = catmullRom(p0, p1, p2, p3, step / 8);
    point.x = Math.max(Math.min(p1.x, p2.x), Math.min(Math.max(p1.x, p2.x), point.x));
    point.y = Math.max(Math.min(p1.y, p2.y), Math.min(Math.max(p1.y, p2.y), point.y));
    railPath.push(point);
  }
}
railPath.push(measuredRailPath.at(-1));

const railLengths = [0];
for (let index = 1; index < railPath.length; index += 1) {
  railLengths.push(railLengths[index - 1] + Math.hypot(railPath[index].x - railPath[index - 1].x, railPath[index].y - railPath[index - 1].y));
}
const railLength = railLengths.at(-1);
const railHalfWidth = 14;
const railWalls = [[], []];
for (let index = 0; index < railPath.length; index += 1) {
  const previous = railPath[Math.max(0, index - 1)];
  const next = railPath[Math.min(railPath.length - 1, index + 1)];
  const tangentLength = Math.hypot(next.x - previous.x, next.y - previous.y) || 1;
  const nx = -(next.y - previous.y) / tangentLength;
  const ny = (next.x - previous.x) / tangentLength;
  railWalls[0].push({ x: railPath[index].x + nx * railHalfWidth, y: railPath[index].y + ny * railHalfWidth });
  railWalls[1].push({ x: railPath[index].x - nx * railHalfWidth, y: railPath[index].y - ny * railHalfWidth });
}
const innerRailEndIndex = railPath.findIndex((point) => point.x >= 285 && point.y <= 410);
const railWallSegments = railWalls.flatMap((wall, wallIndex) => wall.slice(1).map((point, index) => ({
  ax: wall[index].x, ay: wall[index].y, bx: point.x, by: point.y, wallIndex, index,
}))).filter((segment) => segment.wallIndex !== 0 || segment.index < innerRailEndIndex);

export const LAUNCH_MAXIMUM_SPEED = 5040;
export const LAUNCH_CHARGE_TIME = 650;
export const PLAYFIELD_CENTER = Object.freeze({ x: 438, y: 690 });
export const PLAYFIELD_MAXIMUM_CENTER_RADIUS = 351;
const railRollingResistance = 32;
const minimumBumperExitSpeed = 1500;
const railHeightGain = railPath[0].y - railPath.at(-1).y;
export const MINIMUM_SUCCESSFUL_LAUNCH_SPEED = Math.sqrt(
  minimumBumperExitSpeed ** 2 + 2 * PHYSICS.gravity * railHeightGain + 2 * railRollingResistance * railLength
) * 1.015;

function rotatedNormal(nx, ny, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { nx: nx * cosine - ny * sine, ny: nx * sine + ny * cosine };
}

function resolveRailWalls(ball) {
  for (let pass = 0; pass < 3; pass += 1) {
    let deepestContact = null;
    for (const segment of railWallSegments) {
      const abx = segment.bx - segment.ax;
      const aby = segment.by - segment.ay;
      const lengthSquared = abx * abx + aby * aby;
      if (lengthSquared <= .0001) continue;
      const projection = Math.max(0, Math.min(1, ((ball.x - segment.ax) * abx + (ball.y - segment.ay) * aby) / lengthSquared));
      const closestX = segment.ax + abx * projection;
      const closestY = segment.ay + aby * projection;
      const dx = ball.x - closestX;
      const dy = ball.y - closestY;
      const distance = Math.hypot(dx, dy);
      if (distance >= ball.r) continue;
      const overlap = ball.r - distance;
      const nx = distance > .001 ? dx / distance : -aby / Math.sqrt(lengthSquared);
      const ny = distance > .001 ? dy / distance : abx / Math.sqrt(lengthSquared);
      if (!deepestContact || overlap > deepestContact.overlap) deepestContact = { nx, ny, overlap, segment };
    }
    if (!deepestContact) break;
    const { nx: geometryNx, ny: geometryNy, overlap, segment } = deepestContact;
    ball.x += geometryNx * (overlap + .01);
    ball.y += geometryNy * (overlap + .01);
    const roughness = surfaceVariation(ball.seed, `rail:${segment.wallIndex}:${segment.index}`) * .0025;
    const { nx, ny } = rotatedNormal(geometryNx, geometryNy, roughness);
    if (ball.vx * nx + ball.vy * ny < 0) {
      const restitution = .035 + surfaceVariation(ball.seed, `rail:${segment.wallIndex}:${segment.index}:e`) * .006;
      resolveBallImpact(ball, nx, ny, restitution, .018);
    }
  }
}

function resolveRoundBumper(ball, centerX, centerY, side) {
  const dx = ball.x - centerX;
  const dy = ball.y - centerY;
  const distance = Math.hypot(dx, dy);
  const contactFlag = side === 'right' ? 'rightBumperContact' : 'leftBumperContact';
  if (distance >= 29.5) {
    if (distance > 31) ball[contactFlag] = false;
    return false;
  }

  const geometryNx = dx / (distance || 1);
  const geometryNy = dy / (distance || 1);
  ball.x = centerX + geometryNx * 29.51;
  ball.y = centerY + geometryNy * 29.51;
  if (ball[contactFlag]) return false;

  const roughness = surfaceVariation(ball.seed, `${side}-bumper:normal`) * .022;
  const { nx, ny } = rotatedNormal(geometryNx, geometryNy, roughness);
  if (ball.vx * nx + ball.vy * ny >= 0) return false;
  // The right bumper behaves like a sprung rubber cap: it returns more of the
  // incoming normal velocity and grips the ball slightly more tangentially.
  // The left bumper retains the established metal-like response.
  const restitutionBase = side === 'right' ? .88 : .34;
  const frictionBase = side === 'right' ? .085 : .055;
  const restitution = restitutionBase + surfaceVariation(ball.seed, `${side}-bumper:restitution`) * .025;
  const friction = frictionBase + surfaceVariation(ball.seed, `${side}-bumper:friction`) * .01;
  resolveBallImpact(ball, nx, ny, restitution, friction);

  // The sole safety exception requested for the upper right bumper: separate
  // a nearly motionless contact along its physical rebound vector.
  if (side === 'right') {
    const reboundSpeed = Math.hypot(ball.vx, ball.vy);
    if (reboundSpeed < 220) {
      const scale = 220 / (reboundSpeed || 1);
      ball.vx = reboundSpeed ? ball.vx * scale : nx * 220;
      ball.vy = reboundSpeed ? ball.vy * scale : ny * 220;
    }
  }
  ball[contactFlag] = true;
  if (side === 'left') ball.hasPassedLeftBumper = true;
  return true;
}

export function createShotBall(seed, launchSpeed) {
  const start = railPath[0];
  const next = railPath[1];
  const tangentAngle = Math.atan2(next.y - start.y, next.x - start.x);
  const launchAngle = tangentAngle + surfaceVariation(seed, 'launch-angle') * .0025;
  const effectiveSpeed = launchSpeed * (1 + surfaceVariation(seed, 'lever-contact') * .002);
  return {
    x: start.x,
    y: start.y,
    vx: Math.cos(launchAngle) * effectiveSpeed,
    vy: Math.sin(launchAngle) * effectiveSpeed,
    r: 8.5,
    // The lever strikes close to the centre of the steel ball. Spin is then
    // generated by real tangential rail and obstacle contacts.
    omega: 0,
    angle: 0,
    phase: 'launch',
    seed,
    launchSpeed,
    railElapsed: 0,
    reachedUpperRail: false,
    hasPassedLeftBumper: false,
    leftBumperContact: false,
    rightBumperContact: false,
  };
}

export function stepShotPhysics(ball, dt = 1 / 120) {
  const events = { impacts: [], leftBumper: false, rightBumper: false, enteredChannel: null, returned: false };
  if (ball.phase === 'launch') {
    for (let substep = 0; substep < 4; substep += 1) {
      const step = dt / 4;
      ball.railElapsed += step;
      ball.vy += PHYSICS.gravity * step;
      const drag = Math.exp(-PHYSICS.airDrag * step);
      ball.vx *= drag;
      ball.vy *= drag;
      ball.omega *= Math.exp(-PHYSICS.spinDrag * step);
      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed > 0) {
        const resistedSpeed = Math.max(0, speed - railRollingResistance * step);
        ball.vx *= resistedSpeed / speed;
        ball.vy *= resistedSpeed / speed;
      }
      ball.angle += ball.omega * step;
      ball.x += ball.vx * step;
      ball.y += ball.vy * step;
      resolveRailWalls(ball);

      events.leftBumper ||= resolveRoundBumper(ball, 294, 421, 'left');
      if (resolveRoundBumper(ball, 633, 417, 'right')) {
        events.rightBumper = true;
        ball.phase = 'drop';
        break;
      }

      if (ball.y < 455) ball.reachedUpperRail = true;
      if (ball.reachedUpperRail) {
        const passage = (ball.x - 294) * .87 - (ball.y - 421) * .5;
        if (passage > 12) ball.hasPassedLeftBumper = true;
        const playfieldDistance = Math.hypot(ball.x - PLAYFIELD_CENTER.x, ball.y - PLAYFIELD_CENTER.y);
        if (ball.hasPassedLeftBumper && playfieldDistance < PLAYFIELD_MAXIMUM_CENTER_RADIUS - 18) {
          ball.phase = 'drop';
          break;
        }
      }
    }

    const start = railPath[0];
    const startDistance = Math.hypot(ball.x - start.x, ball.y - start.y);
    if (ball.phase === 'launch' && ball.railElapsed > .2 && (startDistance < 18 || ball.railElapsed > 8)) {
      ball.phase = 'returned';
      events.returned = true;
    }
    return events;
  }

  if (ball.phase !== 'drop') return events;
  const dropSubsteps = Math.max(1, Math.ceil(Math.hypot(ball.vx, ball.vy) * dt / ball.r));
  for (let substep = 0; substep < dropSubsteps && ball.y <= PHYSICS.maskEntryY; substep += 1) {
    const result = stepDropPhysics(ball, dt / dropSubsteps, pins, catcherSegments);
    events.impacts.push(...result.impacts);
    events.rightBumper ||= resolveRoundBumper(ball, 633, 417, 'right');
    resolveCircularBoundary(ball, PLAYFIELD_CENTER.x, PLAYFIELD_CENTER.y, PLAYFIELD_MAXIMUM_CENTER_RADIUS);
  }
  if (ball.y > PHYSICS.maskEntryY) {
    events.enteredChannel = channelAtSlotRow(ball.x);
    ball.phase = 'entered';
  }
  return events;
}

export function simulateShot(seed, launchSpeed) {
  const ball = createShotBall(seed, launchSpeed);
  const maximumSteps = 12 * 120;
  for (let step = 0; step < maximumSteps; step += 1) {
    const events = stepShotPhysics(ball);
    if (events.enteredChannel != null) return { channel: events.enteredChannel, elapsed: (step + 1) / 120 };
    if (events.returned) return { channel: null, elapsed: (step + 1) / 120 };
  }
  return { channel: null, elapsed: maximumSteps / 120 };
}
