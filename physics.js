const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export const PHYSICS = Object.freeze({
  gravity: 1050,
  maxHorizontalSpeed: 6000,
  maxDownwardSpeed: 6000,
  maxUpwardSpeed: 6000,
  airDrag: .1,
  spinDrag: .18,
  maskEntryY: 640,
});

export function channelAtSlotRow(x) {
  return clamp(Math.floor((x - 173) / 42), 0, 13);
}

// Stable FNV-1a based surface variation. It depends only on the shot seed and
// the touched body, never on frame rate or collision-loop timing.
export function surfaceVariation(seed, bodyKey) {
  const text = `${seed ?? ''}:${bodyKey}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function rotatedNormal(nx, ny, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { nx: nx * cosine - ny * sine, ny: nx * sine + ny * cosine };
}

/**
 * Rigid-body collision of a solid ball against a stationary surface. Normal
 * restitution and Coulomb-limited tangential friction update translation and
 * spin together. No collision impulse can increase total kinetic energy.
 */
export function resolveBallImpact(ball, nx, ny, restitution, friction) {
  const normalLength = Math.hypot(nx, ny) || 1;
  nx /= normalLength;
  ny /= normalLength;
  const normalSpeed = ball.vx * nx + ball.vy * ny;
  if (normalSpeed >= 0) return false;

  const normalImpulse = -(1 + clamp(restitution, 0, 1)) * normalSpeed;
  ball.vx += normalImpulse * nx;
  ball.vy += normalImpulse * ny;

  const tx = -ny;
  const ty = nx;
  const radius = ball.r || 1;
  const inertia = .5 * radius * radius;
  const contactSlip = ball.vx * tx + ball.vy * ty - (ball.omega || 0) * radius;
  const effectiveMass = 1 + radius * radius / inertia;
  const frictionLimit = normalImpulse * Math.max(0, friction);
  const tangentialImpulse = clamp(-contactSlip / effectiveMass, -frictionLimit, frictionLimit);
  ball.vx += tangentialImpulse * tx;
  ball.vy += tangentialImpulse * ty;
  ball.omega = (ball.omega || 0) - radius * tangentialImpulse / inertia;
  return true;
}

export function resolveCircleImpact(vx, vy, nx, ny, restitution, friction) {
  const ball = { vx, vy, r: 1, omega: 0 };
  resolveBallImpact(ball, nx, ny, restitution, friction);
  return { vx: ball.vx, vy: ball.vy };
}

export function resolveCircularBoundary(ball, centerX, centerY, maximumCenterRadius, restitution = .28, friction = .055) {
  const dx = ball.x - centerX;
  const dy = ball.y - centerY;
  const distance = Math.hypot(dx, dy);
  if (distance <= maximumCenterRadius) return false;
  const outwardX = dx / (distance || 1);
  const outwardY = dy / (distance || 1);
  ball.x = centerX + outwardX * maximumCenterRadius;
  ball.y = centerY + outwardY * maximumCenterRadius;
  if (ball.vx * outwardX + ball.vy * outwardY > 0) {
    resolveBallImpact(ball, -outwardX, -outwardY, restitution, friction);
  }
  return true;
}

/** Integrates one fixed free-fall step after the guide-rail exit. */
export function stepDropPhysics(ball, dt, pins, segments = []) {
  const previousX = ball.x;
  const previousY = ball.y;
  const impacts = [];
  const drag = Math.exp(-PHYSICS.airDrag * dt);

  ball.vy = clamp(ball.vy + PHYSICS.gravity * dt, -PHYSICS.maxUpwardSpeed, PHYSICS.maxDownwardSpeed);
  ball.vx = clamp(ball.vx * drag, -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
  ball.vy *= drag;
  ball.omega = (ball.omega || 0) * Math.exp(-PHYSICS.spinDrag * dt);
  ball.angle = (ball.angle || 0) + ball.omega * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const impulsedBodies = new Set();

  function resolveContact(geometryNx, geometryNy, overlap, bodyKey, catcher, impactIndex) {
    ball.x += geometryNx * (overlap + .01);
    ball.y += geometryNy * (overlap + .01);
    if (impulsedBodies.has(bodyKey)) return;

    // Microscopic fixed imperfections replace anti-stall kicks. A perfectly
    // centred ball therefore rolls to one side naturally under gravity.
    const variation = surfaceVariation(ball.seed, `${bodyKey}:normal`);
    const roughnessMagnitude = (catcher ? .003 : .007) + Math.abs(variation) * (catcher ? .004 : .011);
    const roughness = (variation < 0 ? -1 : 1) * roughnessMagnitude;
    const { nx, ny } = rotatedNormal(geometryNx, geometryNy, roughness);
    const normalSpeed = ball.vx * nx + ball.vy * ny;
    if (normalSpeed >= -.5) return;
    impulsedBodies.add(bodyKey);

    const restitutionBase = catcher ? .105 : .33;
    const restitutionSpread = catcher ? .012 : .018;
    const frictionBase = catcher ? .145 : .075;
    const frictionSpread = catcher ? .012 : .008;
    const restitution = restitutionBase + surfaceVariation(ball.seed, `${bodyKey}:restitution`) * restitutionSpread;
    const friction = frictionBase + surfaceVariation(ball.seed, `${bodyKey}:friction`) * frictionSpread;
    resolveBallImpact(ball, nx, ny, restitution, friction);

    ball.vx = clamp(ball.vx, -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
    ball.vy = clamp(ball.vy, -PHYSICS.maxUpwardSpeed, PHYSICS.maxDownwardSpeed);
    impacts.push({ index: impactIndex, speed: -normalSpeed, catcher });
  }

  for (let pass = 0; pass < 4; pass += 1) {
    pins.forEach((pin, index) => {
      const dx = ball.x - pin.x;
      const dy = ball.y - pin.y;
      const minimum = ball.r + pin.r;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= minimum * minimum) return;
      const distance = Math.sqrt(distanceSquared);
      const nx = distance > .0001 ? dx / distance : 0;
      const ny = distance > .0001 ? dy / distance : -1;
      resolveContact(nx, ny, minimum - distance, `pin:${index}`, Boolean(pin.catcher), index);
    });

    segments.forEach((segment, index) => {
      const abx = segment.bx - segment.ax;
      const aby = segment.by - segment.ay;
      const lengthSquared = abx * abx + aby * aby;
      const projection = lengthSquared > 0
        ? clamp(((ball.x - segment.ax) * abx + (ball.y - segment.ay) * aby) / lengthSquared, 0, 1)
        : 0;
      const closestX = segment.ax + abx * projection;
      const closestY = segment.ay + aby * projection;
      const dx = ball.x - closestX;
      const dy = ball.y - closestY;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= ball.r * ball.r) return;
      const distance = Math.sqrt(distanceSquared);
      let nx;
      let ny;
      if (distance > .0001) {
        nx = dx / distance;
        ny = dy / distance;
      } else {
        const length = Math.sqrt(lengthSquared) || 1;
        nx = -aby / length;
        ny = abx / length;
        if (ball.vx * nx + ball.vy * ny > 0) { nx = -nx; ny = -ny; }
      }
      resolveContact(nx, ny, ball.r - distance, `segment:${segment.group ?? index}`, Boolean(segment.catcher), pins.length + index);
    });
  }

  return { impacts, deltaX: ball.x - previousX, deltaY: ball.y - previousY };
}
