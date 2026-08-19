import fs from 'node:fs';
import { PNG } from 'pngjs';

const sourcePath = new URL('../satsball-source.png', import.meta.url);
const targetPath = new URL('../satsball-edit.png', import.meta.url);
const source = PNG.sync.read(fs.readFileSync(sourcePath));
const output = new PNG({ width: source.width, height: source.height });
source.data.copy(output.data);

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = clamp01(((x - ax) * dx + (y - ay) * dy) / lengthSquared);
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

function blendDonor(x, y, donorX, donorY, amount) {
  if (amount <= 0) return;
  const targetIndex = (source.width * y + x) << 2;
  const sampleX = Math.max(0, Math.min(source.width - 1, Math.round(donorX)));
  const sampleY = Math.max(0, Math.min(source.height - 1, Math.round(donorY)));
  const donorIndex = (source.width * sampleY + sampleX) << 2;

  for (let channel = 0; channel < 3; channel += 1) {
    output.data[targetIndex + channel] = Math.round(
      source.data[targetIndex + channel] * (1 - amount) + source.data[donorIndex + channel] * amount,
    );
  }
  output.data[targetIndex + 3] = 255;
}

// Remove the long moving shaft. The upper bearing and linkage stay on the
// cabinet because they are the fixed mechanical pivot. A same-row donor from
// the unobstructed gold plate retains the original paper grain and shading.
for (let y = 1088; y <= 1191; y += 1) {
  for (let x = 623; x <= 684; x += 1) {
    const shaftDistance = distanceToSegment(x, y, 666, 1091, 648, 1173);
    const lowerGripDistance = Math.hypot(x - 648, y - 1173);
    const maskDistance = Math.min(shaftDistance, lowerGripDistance);
    const amount = clamp01((18 - maskDistance) / 4);
    if (!amount) continue;

    // Above the plate the concealed surface is the cream launch-channel bed;
    // below it we borrow the untouched gold texture farther to the right.
    const donorX = y < 1107 ? x - 62 : x + 112;
    blendDonor(x, y, donorX, y, amount);
  }
}

// Clean the old lower pivot completely. Its partially feathered bright rim
// otherwise remains visible around the CSS-rendered bearing while the lever
// moves. Sample unobstructed gold from the same row to preserve plate texture.
for (let y = 1139; y <= 1205; y += 1) {
  for (let x = 615; x <= 681; x += 1) {
    const distance = Math.hypot(x - 648, y - 1173);
    const amount = clamp01((32 - distance) / 3);
    if (!amount) continue;
    const normalizedX = Math.min(1, Math.abs(x - 648) / 33);
    const plateBottom = 1192 + 9 * (1 - normalizedX * normalizedX);
    if (y >= plateBottom - 7) continue;
    const donorX = 760 + ((x - 615) % 20);
    const donorY = 1125 + ((y - 1139) % 20);
    blendDonor(x, y, donorX, donorY, amount);
  }
}

// Remove the separate right finger pull from the gold plate. Its replacement
// is rendered as a foreground control by CSS, above the START button.
for (let y = 1138; y <= 1202; y += 1) {
  for (let x = 692; x <= 749; x += 1) {
    const ellipse = Math.hypot((x - 721) / 1.04, (y - 1170) / 1.14);
    const amount = clamp01((24 - ellipse) / 4);
    if (!amount) continue;
    blendDonor(x, y, x + 58, y, amount);
  }
}

fs.writeFileSync(targetPath, PNG.sync.write(output));
console.log(targetPath.pathname);
