const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export const PHYSICS = Object.freeze({
  gravity: 1050,
  maxHorizontalSpeed: 820,
  maxDownwardSpeed: 650,
  maxUpwardSpeed: 210,
  // The triangular catcher geometry ends above this line. From here on the
  // ball is safely inside one shaft, but it keeps its remaining momentum.
  maskEntryY: 640,
});

// Calibrated bumper-exit impulses. Every profile reaches its channel through
// the visible nail field and between the corresponding catcher teeth. Picking
// among several profiles keeps repeated results varied without correcting the
// ball's position after it has entered a slot.
export const DROP_PROFILES = Object.freeze([
  [[-617, 57], [-658, 61], [-735, 91], [-675, 75], [-718, 88]],
  [[-613, 56], [-596, 192], [-585, 178], [-773, 115], [-599, 181]],
  [[-469, 124], [-491, 140], [-523, 175], [-576, 172], [-685, 72]],
  [[-548, 149], [-457, 117], [-457, 125], [-541, 162], [-579, 204]],
  [[-460, 125], [-450, 127], [-422, 104], [-392, 73], [-490, 132]],
  [[-471, 129], [-366, 61], [-391, 87], [-394, 70], [-439, 111]],
  [[-396, 73], [-337, 59], [-392, 95], [-392, 85], [-384, 86]],
  [[-112, 82], [-77, 101], [-81, 113], [-101, 133], [-81, 120]],
  [[-99, 83], [10, 59], [-16, 96], [10, 66], [-18, 75]],
  [[-6, 68], [-4, 80], [7, 96], [27, 205], [-12, 78]],
  [[-3, 94], [-98, 89], [12, 125], [-98, 108], [-17, 123]],
  [[-26, 68], [-35, 66], [-41, 84], [-25, 77], [-28, 92]],
  [[253, 75], [239, 71], [264, 83], [263, 106], [249, 68]],
  [[292, 124], [251, 78], [229, 65], [246, 84], [242, 90]],
]);

export function channelAtSlotRow(x) {
  return clamp(Math.floor((x - 173) / 42), 0, 13);
}

/**
 * Integrates one fixed drop step. The function is deliberately deterministic:
 * randomness is introduced only once at launch, never repeatedly while two
 * bodies overlap. This prevents a contact from accumulating artificial energy.
 */
export function stepDropPhysics(ball, dt, _targetX, pins, segments = []) {
  const previousX = ball.x;
  const previousY = ball.y;
  const impacts = [];

  ball.vy = clamp(ball.vy + PHYSICS.gravity * dt, -PHYSICS.maxUpwardSpeed, PHYSICS.maxDownwardSpeed);
  ball.vx = clamp(ball.vx * Math.exp(-.45 * dt), -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const leftWall = 183 + ball.r;
  const rightWall = 751 - ball.r;
  if (ball.x < leftWall) {
    ball.x = leftWall;
    if (ball.vx < 0) ball.vx = Math.min(PHYSICS.maxHorizontalSpeed, -ball.vx * .55);
  } else if (ball.x > rightWall) {
    ball.x = rightWall;
    if (ball.vx > 0) ball.vx = Math.max(-PHYSICS.maxHorizontalSpeed, -ball.vx * .55);
  }

  let pinContact = false;
  let catcherContact = false;
  let contactEscapeDirection = 0;
  let deepestContact = -1;
  const impulsedBodies = new Set();

  function resolveContact(nx, ny, overlap, bodyKey, catcher, impactIndex) {
    pinContact = true;
    catcherContact ||= catcher;
    if (overlap > deepestContact) {
      deepestContact = overlap;
      contactEscapeDirection = Math.sign(nx) || ball.escapeDirection || 1;
    }

    ball.x += nx * (overlap + .01);
    ball.y += ny * (overlap + .01);

    const normalSpeed = ball.vx * nx + ball.vy * ny;
    if (impulsedBodies.has(bodyKey) || normalSpeed >= -.5) return;
    impulsedBodies.add(bodyKey);

    // Standard rigid-body reflection against a stationary surface. Friction
    // is limited by the normal impulse, so a grazing hit cannot create a
    // sideways kick or add energy to the ball.
    const restitution = catcher ? .18 : .38;
    const normalImpulse = Math.min(500, -(1 + restitution) * normalSpeed);
    ball.vx += normalImpulse * nx;
    ball.vy += normalImpulse * ny;

    const tx = -ny;
    const ty = nx;
    const tangentSpeed = ball.vx * tx + ball.vy * ty;
    const frictionLimit = normalImpulse * (catcher ? .12 : .065);
    const frictionImpulse = clamp(-tangentSpeed, -frictionLimit, frictionLimit);
    ball.vx += frictionImpulse * tx;
    ball.vy += frictionImpulse * ty;

    ball.vx = clamp(ball.vx, -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
    ball.vy = clamp(ball.vy, -PHYSICS.maxUpwardSpeed, PHYSICS.maxDownwardSpeed);
    impacts.push({ index: impactIndex, speed: -normalSpeed, catcher });
  }

  // Four positional passes resolve contacts in the narrow gaps between two
  // pins or at a catcher tip. Each body may add only one impulse per step,
  // so the extra separation passes cannot create artificial energy.
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
      const overlap = minimum - distance;
      resolveContact(nx, ny, overlap, `pin:${index}`, Boolean(pin.catcher), index);
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
      resolveContact(
        nx,
        ny,
        ball.r - distance,
        `segment:${segment.group ?? index}`,
        Boolean(segment.catcher),
        pins.length + index,
      );
    });
  }

  ball.escapeTime = Math.max(0, (ball.escapeTime || 0) - dt);

  // A mathematically exact hit on the top of a round pin can balance forever.
  // After 0.26 s of genuine low-speed contact, apply one small rolling impulse.
  const slowContact = pinContact && Math.hypot(ball.vx, ball.vy) < 48 && Math.abs(ball.y - previousY) < .18;
  ball.stallTime = slowContact ? (ball.stallTime || 0) + dt : Math.max(0, (ball.stallTime || 0) - dt * 2);
  const stallLimit = catcherContact ? .12 : .18;
  if (ball.stallTime >= stallLimit) {
    const direction = contactEscapeDirection || ball.escapeDirection || 1;
    const rollSpeed = catcherContact ? 30 : 24;
    ball.vx = clamp(ball.vx + direction * rollSpeed, -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
    ball.vy = Math.max(ball.vy, catcherContact ? 24 : 36);
    ball.escapeTime = catcherContact ? .24 : .18;
    ball.stallTime = 0;
  }

  // Auch ein langsames Pendeln zwischen zwei Nadeln darf nicht mehrere
  // Sekunden dauern. Fortschritt wird an der tiefsten erreichten Position
  // gemessen; erst nach 0.65 s ohne einen weiteren Pixel greift ein kleiner,
  // begrenzter Rollimpuls ein.
  if (ball.maxProgressY == null || ball.y > ball.maxProgressY + 1) {
    ball.maxProgressY = ball.y;
    ball.noProgressTime = 0;
  } else {
    ball.noProgressTime = (ball.noProgressTime || 0) + dt;
  }
  const progressLimit = catcherContact ? .34 : .45;
  if (ball.noProgressTime >= progressLimit) {
    const direction = contactEscapeDirection || ball.escapeDirection || 1;
    ball.vx = clamp(ball.vx + direction * (catcherContact ? 24 : 18), -PHYSICS.maxHorizontalSpeed, PHYSICS.maxHorizontalSpeed);
    ball.vy = Math.max(ball.vy, catcherContact ? 28 : 48);
    ball.escapeTime = catcherContact ? .22 : .15;
    ball.noProgressTime = 0;
  }

  return {
    impacts,
    pinContact,
    catcherContact,
    deltaX: ball.x - previousX,
    deltaY: ball.y - previousY,
  };
}
