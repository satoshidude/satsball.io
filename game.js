import { channelAtSlotRow, DROP_PROFILES, PHYSICS, stepDropPhysics } from './physics.js';

if (new URLSearchParams(window.location.search).has('export')) {
  document.documentElement.classList.add('export-render');
}

const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const catcherForeground = new Image();
catcherForeground.src = 'satsball-edit.png';
const playButton = document.querySelector('#playButton');
const machine = document.querySelector('.machine');
const withdrawButton = document.querySelector('#withdrawButton');
const autoplayButton = document.querySelector('#autoplayButton');
const soundToggle = document.querySelector('#soundToggle');
const balanceEl = document.querySelector('#balance');
const winEl = document.querySelector('#winAmount');
const depositButton = document.querySelector('#depositButton');
const displayTitle = document.querySelector('.digital-display__title');
const depositModal = document.querySelector('#depositModal');
const depositHint = document.querySelector('#depositHint');
const depositAmounts = document.querySelector('#depositAmounts');
const invoicePanel = document.querySelector('#invoicePanel');
const invoiceQr = document.querySelector('#invoiceQr');
const invoiceAmount = document.querySelector('#invoiceAmount');
const invoiceText = document.querySelector('#invoiceText');
const invoiceStatus = document.querySelector('#invoiceStatus');
const openDepositInAlbyGo = document.querySelector('#openDepositInAlbyGo');
const copyInvoiceButton = document.querySelector('#copyInvoice');
const payoutModal = document.querySelector('#payoutModal');
const payoutHint = document.querySelector('#payoutHint');
const payoutLnurlPanel = document.querySelector('#payoutLnurl');
const payoutQr = document.querySelector('#payoutQr');
const payoutAmount = document.querySelector('#payoutAmount');
const openPayoutInAlbyGo = document.querySelector('#openPayoutInAlbyGo');
const copyPayoutLnurlButton = document.querySelector('#copyPayoutLnurl');
const payoutInvoice = document.querySelector('#payoutInvoice');
const scanPayoutButton = document.querySelector('#scanPayout');
const pastePayoutButton = document.querySelector('#pastePayout');
const payoutImage = document.querySelector('#payoutImage');
const submitPayoutButton = document.querySelector('#submitPayout');
const startActionEl = document.querySelector('#startAction');
const startDetailEl = document.querySelector('#startDetail');
const statusEl = document.querySelector('#roundStatus');
const messageEl = document.querySelector('#message');
const trayEl = document.querySelector('#trayText');

const channelNumbers = [4, 1, 3, 2, 4, 3, 1, 4, 2, 4, 3, 1, 2, 4];
const matrix = [[1,3,4,1,2,2,1], [2,3,4,1,2,3,3], [3,3,4,1,2,4,4]];
const payouts = [10, 20, 40, 100, 80, 20, 10];
// Mittelpunkte der farbigen Innenflächen in satsball-edit.png (876 × 1235).
const lampX = [105, 175, 246, 318, 390, 461, 531];
const lampY = [105, 161, 217];
const lampWidth = 54;
const lampHeight = 46;
const prizeTop = 255;
const prizeWidth = 54;
const prizeHeight = 57;
const state = { balance: 0, depositRemaining: 5000, lastWin: 0, active: false, waitingForShot: false, syncing: false, autoplay: false, roundId: null, settlement: null, ball: null, ballIndex: 0, results: [], hitColumns: [], sound: true, lastTime: 0, accumulator: 0 };
let autoplayTimer = 0;

const pins = [];
[
  { count: 12, x: 238, y: 466 },
  { count: 13, x: 217, y: 503 },
  { count: 14, x: 196, y: 540 },
].forEach((row) => {
  for (let col = 0; col < row.count; col += 1) pins.push({ x: row.x + col * 42, y: row.y, r: 9 });
});

// Jede sichtbare Trennzacke besitzt zwei schräge Kollisionsflächen. So folgt
// der Abprall der gezeichneten Metallkante statt einem unsichtbaren Kreis.
const catcherSegments = [];
for (let divider = 0; divider <= 14; divider += 1) {
  const x = 173 + divider * 42;
  catcherSegments.push(
    { ax: x, ay: 603, bx: x - 10, by: 625, catcher: true, group: divider },
    { ax: x, ay: 603, bx: x + 10, by: 625, catcher: true, group: divider },
  );
}

// Aus den roten Führungsplanken der Hintergrundgrafik vermessene Kanalmitte.
// Die dichte Punktfolge am oberen Bogen verhindert, dass die Kugel die Planken
// selbst bei der stärksten Krümmung berührt oder überschreitet.
const measuredRailPath = [
  [660,1080], [648,1083], [636,1085], [608,1070], [534,1055],
  [483,1040], [429,1025], [379,1010], [336,995], [273,970],
  [184,890], [150,840], [130,790],
  [118,740], [113,690], [117,640], [130,590], [153,540],
  [184,490], [231,440], [293,397], [353,370], [393,361],
  [433,356], [473,356], [513,361], [553,372], [585,382],
  [604,382], [616,393],
].map(([x, y]) => ({x, y}));

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: .5 * ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: .5 * ((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
  };
}

// Nur den oberen Kanal ab y=540 glätten. Acht Zwischenwerte pro Messsegment
// entfernen sichtbare Richtungswechsel, ohne die vermessene Bahn zu verlassen.
const railPath = measuredRailPath.slice(0, 17);
for (let i = 17; i < measuredRailPath.length - 1; i += 1) {
  const p0 = measuredRailPath[Math.max(0, i - 1)];
  const p1 = measuredRailPath[i];
  const p2 = measuredRailPath[i + 1];
  const p3 = measuredRailPath[Math.min(measuredRailPath.length - 1, i + 2)];
  for (let step = 0; step < 8; step += 1) {
    const point = catmullRom(p0, p1, p2, p3, step / 8);
    point.x = Math.max(Math.min(p1.x, p2.x), Math.min(Math.max(p1.x, p2.x), point.x));
    point.y = Math.max(Math.min(p1.y, p2.y), Math.min(Math.max(p1.y, p2.y), point.y));
    railPath.push(point);
  }
}
railPath.push(measuredRailPath.at(-1));
const railLengths = [0];
for (let i = 1; i < railPath.length; i += 1) {
  railLengths.push(railLengths[i - 1] + Math.hypot(railPath[i].x - railPath[i - 1].x, railPath[i].y - railPath[i - 1].y));
}
const railLength = railLengths.at(-1);

let audio;
function tone(frequency, duration = .035, volume = .025, type = 'square') {
  if (!state.sound) return;
  audio ||= new AudioContext();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type; oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + duration);
  oscillator.connect(gain).connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + duration);
}

function metallicTing() {
  if (!state.sound) return;
  audio ||= new AudioContext();
  const now = audio.currentTime;
  const output = audio.createGain();
  output.gain.setValueAtTime(.11, now);
  output.gain.exponentialRampToValueAtTime(.0001, now + .15);
  output.connect(audio.destination);

  const body = audio.createOscillator();
  const bodyGain = audio.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(290, now);
  body.frequency.exponentialRampToValueAtTime(190, now + .045);
  bodyGain.gain.setValueAtTime(.28, now);
  bodyGain.gain.exponentialRampToValueAtTime(.0001, now + .055);
  body.connect(bodyGain).connect(output);

  const ring = audio.createOscillator();
  const ringGain = audio.createGain();
  ring.type = 'sine';
  ring.frequency.setValueAtTime(1560, now);
  ring.frequency.exponentialRampToValueAtTime(1430, now + .11);
  ringGain.gain.setValueAtTime(.72, now);
  ringGain.gain.exponentialRampToValueAtTime(.0001, now + .13);
  ring.connect(ringGain).connect(output);

  const overtone = audio.createOscillator();
  const overtoneGain = audio.createGain();
  overtone.type = 'triangle';
  overtone.frequency.setValueAtTime(2480, now);
  overtone.frequency.exponentialRampToValueAtTime(2260, now + .085);
  overtoneGain.gain.setValueAtTime(.3, now);
  overtoneGain.gain.exponentialRampToValueAtTime(.0001, now + .095);
  overtone.connect(overtoneGain).connect(output);

  const noiseBuffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * .025), audio.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let index = 0; index < noiseData.length; index += 1) noiseData[index] = Math.random() * 2 - 1;
  const noise = audio.createBufferSource();
  const noiseFilter = audio.createBiquadFilter();
  const noiseGain = audio.createGain();
  noise.buffer = noiseBuffer;
  noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 2850; noiseFilter.Q.value = 2.2;
  noiseGain.gain.setValueAtTime(.22, now);
  noiseGain.gain.exponentialRampToValueAtTime(.0001, now + .018);
  noise.connect(noiseFilter).connect(noiseGain).connect(output);

  body.start(now); body.stop(now + .06);
  ring.start(now); ring.stop(now + .14);
  overtone.start(now); overtone.stop(now + .105);
  noise.start(now); noise.stop(now + .02);
}

function updateUI() {
  balanceEl.textContent = state.balance;
  winEl.textContent = state.lastWin;
  displayTitle.classList.toggle('is-empty', state.balance === 0);
  displayTitle.setAttribute('aria-label', state.balance === 0 ? 'INSERT SATS' : 'ADD MORE SATS');
  playButton.disabled = state.syncing || (state.active && !state.waitingForShot);
  depositButton.disabled = state.active;
  autoplayButton.classList.toggle('is-active', state.autoplay);
  autoplayButton.setAttribute('aria-pressed', String(state.autoplay));
  autoplayButton.setAttribute('aria-label', state.autoplay ? 'Disable autoplay' : 'Enable autoplay');
  playButton.classList.toggle('is-start-ready', !state.active && !state.syncing);
  if (!state.active) {
    startActionEl.textContent = 'Start'; startDetailEl.textContent = '10 sats';
    playButton.setAttribute('aria-label', 'Pay 10 sats and start game');
  } else if (state.waitingForShot) {
    startActionEl.textContent = `Ball ${state.ballIndex + 1}`; startDetailEl.textContent = 'Shoot';
    playButton.setAttribute('aria-label', `Shoot ball ${state.ballIndex + 1}`);
  } else {
    startActionEl.textContent = `Ball ${state.ballIndex + 1}`; startDetailEl.textContent = 'Rolling';
  }
}

function clearTable() { state.results = []; state.hitColumns = []; }

function getLitCells() {
  const lit = matrix.map(() => matrix[0].map(() => false));
  state.results.forEach((value) => {
    for (let col = 0; col < matrix[0].length; col += 1) {
      const row = matrix.findIndex((matrixRow, rowIndex) => matrixRow[col] === value && !lit[rowIndex][col]);
      if (row >= 0) lit[row][col] = true;
    }
  });
  return lit;
}

async function startRound() {
  if (state.active) return;
  if (state.balance < 10) {
    messageEl.textContent = 'Not enough balance. Deposit sats to continue.';
    tone(90, .2, .04, 'sawtooth'); openDeposit(); return;
  }
  state.syncing = true; updateUI();
  try {
    const response = await fetch('/api/game/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Game could not be started');
    state.roundId = data.roundId; state.balance = data.balance; state.settlement = null;
  } catch (error) {
    state.syncing = false; updateUI(); messageEl.textContent = error.message; tone(90, .2, .04, 'sawtooth'); return;
  }
  state.syncing = false; state.lastWin = 0; state.active = true; state.waitingForShot = true; state.ballIndex = 0; clearTable();
  statusEl.textContent = 'Ball 1 / 3'; messageEl.textContent = 'Ball 1 is loaded. Pull and release to shoot.'; trayEl.textContent = '—';
  loadBall(); updateUI(); tone(120, .09, .05, 'sawtooth');
  scheduleAutoplay(550);
}

function setAutoplay(enabled) {
  state.autoplay = enabled;
  window.clearTimeout(autoplayTimer);
  if (!enabled) machine.classList.remove('is-pulling');
  updateUI();
  if (!enabled) return;
  if (!state.active && state.balance < 10) {
    state.autoplay = false; updateUI();
    openDeposit();
    return;
  }
  scheduleAutoplay(250);
}

function scheduleAutoplay(delay) {
  window.clearTimeout(autoplayTimer);
  if (!state.autoplay) return;
  autoplayTimer = window.setTimeout(() => {
    if (!state.autoplay || state.syncing || state.ball?.phase !== 'loaded' && state.active) return;
    if (!state.active) { handlePlay(); return; }
    machine.classList.add('is-pulling');
    autoplayTimer = window.setTimeout(() => {
      machine.classList.remove('is-pulling');
      if (state.autoplay) autoplayTimer = window.setTimeout(() => { metallicTing(); handlePlay(); }, 95);
    }, 240);
  }, delay);
}

function launchBall(targetChannel) {
  state.ball = { x: 660, y: 1080, vx: 0, vy: 0, r: 8.5, phase: 'launch', pathT: 0, targetChannel, collisions: new Set(), escapeDirection: (state.ballIndex + targetChannel) % 2 ? 1 : -1 };
}

function loadBall() {
  state.ball = { x: 660, y: 1080, vx: 0, vy: 0, r: 8.5, phase: 'loaded', pathT: 0, collisions: new Set() };
}

function finishBall(channel) {
  if (!state.ball) return;
  const value = channelNumbers[channel]; state.results.push(value); state.ball = null; state.ballIndex += 1;
  tone(220 + value * 85, .16, .045, 'triangle');
  if (state.ballIndex < 3) {
    state.waitingForShot = true;
    loadBall();
    statusEl.textContent = `Ball ${state.ballIndex + 1} / 3`; messageEl.textContent = `Field ${value}. Shoot the next ball manually.`;
    updateUI();
    scheduleAutoplay(550);
  } else setTimeout(resolveRound, 450);
}

async function resolveRound() {
  const settlement = state.settlement;
  const win = settlement?.win || 0;
  if (settlement) { state.results = settlement.results; state.hitColumns = settlement.hitColumns; state.balance = settlement.balance; }
  state.lastWin = win;
  if (win) {
    statusEl.textContent = `Win: ${win} sats`; messageEl.textContent = `${state.results.join(' · ')} completes ${state.hitColumns.length > 1 ? 'two lines' : 'one line'}.`; trayEl.textContent = `+ ${win} sats`;
    [440, 554, 659, 880].forEach((note, index) => setTimeout(() => tone(note, .22, .035, 'triangle'), index * 120));
  } else {
    statusEl.textContent = 'No win'; messageEl.textContent = `${state.results.join(' · ')} does not complete a winning line.`; trayEl.textContent = '0 sats';
  }
  state.active = false; state.waitingForShot = false; state.ball = null; updateUI();
  if (state.autoplay && state.balance >= 10) scheduleAutoplay(900);
  else if (state.autoplay) setAutoplay(false);
}

function resetDemo() {
  if (state.active) return;
  state.lastWin = 0; state.ball = null; clearTable(); statusEl.textContent = 'Ready'; messageEl.textContent = 'Display reset. Pay 10 sats to play.'; trayEl.textContent = 'SAT / LN'; updateUI(); tone(330, .08, .025, 'triangle');
}

let currentInvoice = '';
let depositPoll = 0;

function openDeposit() {
  if (state.active) return;
  window.clearInterval(depositPoll); currentInvoice = '';
  openDepositInAlbyGo.removeAttribute('href');
  invoicePanel.hidden = true; depositAmounts.hidden = false; updateDepositOptions();
  depositModal.showModal();
}

function updateDepositOptions() {
  depositAmounts.querySelectorAll('[data-amount]').forEach((button) => { button.disabled = Number(button.dataset.amount) > state.depositRemaining; });
  depositHint.textContent = state.depositRemaining > 0 ? `Daily remaining: ${state.depositRemaining} sats` : 'Daily deposit limit reached';
}

function openPayout() {
  if (state.active) return;
  window.clearInterval(payoutPoll); currentPayoutLnurl = ''; payoutLnurlPanel.hidden = true;
  openPayoutInAlbyGo.removeAttribute('href');
  payoutInvoice.value = ''; payoutHint.textContent = 'Creating payout QR…';
  submitPayoutButton.disabled = false; payoutModal.showModal(); createPayoutLnurl();
}

let currentPayoutLnurl = '';
let payoutPoll = 0;

async function createPayoutLnurl() {
  try {
    const response = await fetch('/api/lnurl/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Payout QR could not be created');
    currentPayoutLnurl = data.lnurl; payoutQr.src = data.qr; payoutAmount.textContent = data.amount;
    openPayoutInAlbyGo.href = `alby:${data.lnurl}`;
    payoutLnurlPanel.hidden = false; payoutHint.textContent = `Scan with your Lightning wallet · ${data.fee} sat payout fee`;
    const check = async () => {
      const statusResponse = await fetch(`/api/lnurl/withdraw/status/${encodeURIComponent(data.k1)}`, { cache: 'no-store' });
      const status = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(status.error || 'Payout status unavailable');
      if (status.state === 'settled') {
        window.clearInterval(payoutPoll); state.balance = status.balance; updateUI(); payoutHint.textContent = `${status.amount} sats paid`;
        tone(740, .2, .04, 'triangle'); setTimeout(() => payoutModal.close(), 1100);
      } else if (status.state === 'paying') payoutHint.textContent = 'Paying your wallet…';
      else if (status.state === 'failed') { window.clearInterval(payoutPoll); state.balance = status.balance; updateUI(); payoutHint.textContent = 'Payment failed. Balance restored.'; }
      else if (status.state === 'review') { window.clearInterval(payoutPoll); state.balance = status.balance; updateUI(); payoutHint.textContent = 'Payment status is being reviewed.'; }
      else if (status.expiresAt * 1000 <= Date.now()) { window.clearInterval(payoutPoll); payoutHint.textContent = 'Payout QR expired. Close and reopen Payout.'; }
    };
    payoutPoll = window.setInterval(() => check().catch(() => { payoutHint.textContent = 'Checking payout…'; }), 1500);
    check().catch(() => { payoutHint.textContent = 'Checking payout…'; });
  } catch (error) { payoutHint.textContent = error.message || 'Payout QR could not be created'; }
}

async function copyPayoutLnurl() {
  if (!currentPayoutLnurl) return;
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(currentPayoutLnurl); copied = true;
    } else {
      const fallback = document.createElement('textarea');
      fallback.value = currentPayoutLnurl; fallback.setAttribute('readonly', '');
      fallback.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(fallback);
      fallback.select(); fallback.setSelectionRange(0, fallback.value.length);
      copied = document.execCommand('copy'); fallback.remove();
    }
  } catch { copied = false; }
  copyPayoutLnurlButton.textContent = copied ? 'Copied' : 'Copy blocked';
  payoutHint.textContent = copied ? 'Payout link copied' : 'Copy blocked by browser';
  setTimeout(() => { copyPayoutLnurlButton.textContent = 'Copy payout link'; }, 1400);
}

async function pastePayoutInvoice() {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('Press ⌘V to paste');
    payoutInvoice.value = await navigator.clipboard.readText(); payoutHint.textContent = `Available: ${state.balance} sats`;
  } catch (error) { payoutInvoice.focus(); payoutHint.textContent = error.message || 'Press ⌘V to paste'; }
}

async function scanPayoutImage(file) {
  if (!file) return;
  try {
    payoutHint.textContent = 'Reading QR code…';
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = window.jsQR?.(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
    if (!result?.data) throw new Error('No QR code found');
    payoutInvoice.value = result.data.replace(/^lightning:/i, ''); payoutHint.textContent = `Available: ${state.balance} sats`;
  } catch (error) { payoutHint.textContent = error.message || 'QR code could not be read'; }
  finally { payoutImage.value = ''; }
}

async function submitPayout() {
  const invoice = payoutInvoice.value.trim();
  if (!invoice) { payoutHint.textContent = 'Paste or scan a Lightning invoice'; payoutInvoice.focus(); return; }
  submitPayoutButton.disabled = true; payoutHint.textContent = 'Paying invoice…';
  try {
    const response = await fetch('/api/withdrawals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoice }) });
    const data = await response.json();
    if (!response.ok && response.status !== 202) throw new Error(data.error || 'Payout failed');
    state.balance = data.balance; updateUI();
    if (data.state === 'settled') {
      payoutHint.textContent = `${data.amount} sats paid · ${data.fee} sat fee`;
      tone(740, .2, .04, 'triangle'); setTimeout(() => payoutModal.close(), 1100);
    } else payoutHint.textContent = data.error || 'Payment status is being reviewed.';
  } catch (error) {
    payoutHint.textContent = error.message || 'Payout failed';
    try { await loadGuestBalance(); } catch { /* keep last confirmed balance */ }
  } finally { submitPayoutButton.disabled = false; }
}

async function createDeposit(amount) {
  depositAmounts.hidden = true; invoicePanel.hidden = true; depositHint.textContent = 'Creating invoice…';
  try {
    const response = await fetch('/api/deposits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
    const data = await response.json();
    if (data.depositRemaining != null) state.depositRemaining = data.depositRemaining;
    if (!response.ok) throw new Error(data.error || 'Invoice failed');
    currentInvoice = data.invoice; state.depositRemaining = data.depositRemaining; invoiceQr.src = data.qr; invoiceAmount.textContent = data.amount; invoiceText.value = data.invoice;
    openDepositInAlbyGo.href = `alby:${data.invoice}`;
    invoiceStatus.textContent = 'Waiting for payment…'; depositHint.textContent = 'Scan with a Lightning wallet'; invoicePanel.hidden = false;
    const check = async () => {
      const statusResponse = await fetch(`/api/deposits/${encodeURIComponent(data.paymentHash)}`, { cache: 'no-store' });
      const status = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(status.error || 'Status unavailable');
      if (status.state === 'settled') {
        window.clearInterval(depositPoll); state.balance = status.balance; state.lastWin = 0; updateUI();
        invoiceStatus.textContent = 'Payment received'; tone(660, .18, .04, 'triangle');
        setTimeout(() => depositModal.close(), 900);
      } else if (status.expiresAt * 1000 <= Date.now()) {
        window.clearInterval(depositPoll); invoiceStatus.textContent = 'Invoice expired'; depositAmounts.hidden = false; loadGuestBalance();
      }
    };
    depositPoll = window.setInterval(() => check().catch(() => { invoiceStatus.textContent = 'Checking payment…'; }), 1800);
    check().catch(() => { invoiceStatus.textContent = 'Checking payment…'; });
  } catch (error) {
    depositHint.textContent = error.message; depositAmounts.hidden = false; loadGuestBalance();
  }
}

async function loadGuestBalance() {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json(); state.balance = data.balance; state.depositRemaining = data.depositRemaining; updateUI();
    if (depositModal.open) updateDepositOptions();
  } catch { /* Static preview keeps its local demo balance. */ }
}

async function handlePlay() {
  if (!state.active) { startRound(); return; }
  if (!state.waitingForShot) return;
  state.waitingForShot = false; state.syncing = true;
  statusEl.textContent = `Ball ${state.ballIndex + 1} / 3`;
  messageEl.textContent = 'Ball launched through the outer channel.';
  updateUI();
  try {
    const response = await fetch(`/api/game/${encodeURIComponent(state.roundId)}/shot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shotIndex: state.ballIndex }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ball could not be released');
    if (data.settled) state.settlement = data;
    state.syncing = false; updateUI(); tone(120, .09, .05, 'sawtooth'); launchBall(data.channel);
  } catch (error) {
    state.syncing = false; state.waitingForShot = true; messageEl.textContent = error.message; updateUI();
    if (state.autoplay) setAutoplay(false);
  }
}

function updateBall(dt) {
  const b = state.ball; if (!b) return;
  const catcherWidth = 588 / 14;
  const targetX = 173 + catcherWidth * (b.targetChannel + .5);
  if (b.phase === 'loaded') return;
  if (b.phase === 'caught') return;
  if (b.phase === 'catch') {
    // Behind the foreground the remaining lateral momentum decays against
    // the narrow metal shaft. The ball is only locked once that motion is no
    // longer visible, avoiding a discontinuity at the tooth tips.
    b.vy = Math.min(PHYSICS.maxDownwardSpeed, b.vy + PHYSICS.gravity * dt);
    b.vx *= Math.exp(-7 * dt);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const shaftLeft = 173 + b.enteredChannel * 42 + 10 + b.r;
    const shaftRight = 173 + (b.enteredChannel + 1) * 42 - 10 - b.r;
    if (b.x < shaftLeft) { b.x = shaftLeft; if (b.vx < 0) b.vx = -b.vx * .18; }
    if (b.x > shaftRight) { b.x = shaftRight; if (b.vx > 0) b.vx = -b.vx * .18; }
    if (b.y >= 675 || Math.abs(b.vx) < 1) { b.slotX = b.x; b.vx = 0; }
    if (b.y >= 735) {
      b.y = 735;
      b.vy = -Math.min(105, Math.abs(b.vy) * .18);
      b.phase = 'settle';
    }
    return;
  }
  if (b.phase === 'settle') {
    b.x = b.slotX;
    b.vy = Math.min(PHYSICS.maxDownwardSpeed, b.vy + PHYSICS.gravity * dt);
    b.y += b.vy * dt;
    if (b.y >= 735) {
      b.y = 735;
      if (Math.abs(b.vy) < 42) {
        b.phase = 'caught';
        setTimeout(() => { if (state.ball === b) finishBall(b.enteredChannel); }, 260);
      } else {
        b.vy = -Math.abs(b.vy) * .18;
      }
    }
    return;
  }
  if (b.phase === 'launch') {
    b.pathT = Math.min(1, b.pathT + dt * .55);
    const distance = b.pathT * railLength;
    let segment = 1;
    while (segment < railLengths.length - 1 && railLengths[segment] < distance) segment += 1;
    const start = railPath[segment - 1], end = railPath[segment];
    const localT = (distance - railLengths[segment - 1]) / (railLengths[segment] - railLengths[segment - 1]);
    const point = { x: start.x + (end.x - start.x) * localT, y: start.y + (end.y - start.y) * localT };
    b.r = 8.5;
    b.x = point.x; b.y = point.y;
    if (b.pathT >= 1) {
      tone(190, .08, .05, 'square');
      // Bumperzentrum 633/417, äußerer Silberradius ca. 21 px.
      // Der größere Kugelmittelpunkt bleibt beim Kontakt ca. 29,5 px entfernt.
      b.phase = 'bumper'; b.bounceT = 0; b.x = 616; b.y = 393;
    }
    return;
  }

  if (b.phase === 'bumper') {
    b.bounceT = Math.min(1, b.bounceT + dt * 6.5);
    const t = b.bounceT;
    // Rückprall durch die offene Innenseite direkt zum Nagelfeld. Dadurch
    // kreuzt die Kugel nicht erneut die obere rote Ellipsenführung.
    b.x = 616 - 32 * t;
    b.y = 393 + 27 * t + 8 * t * t;
    if (t >= 1) {
      b.phase = 'drop';
      const profiles = DROP_PROFILES[b.targetChannel];
      const profile = profiles[Math.floor(Math.random() * profiles.length)];
      [b.vx, b.vy] = profile;
    }
    return;
  }

  const physicsStep = stepDropPhysics(b, dt, targetX, pins, catcherSegments);
  for (const impact of physicsStep.impacts) {
    if (b.collisions.has(impact.index)) continue;
    tone(impact.catcher ? 500 : 520 + Math.min(440, impact.speed));
    b.collisions.add(impact.index);
    setTimeout(() => b.collisions.delete(impact.index), 80);
  }
  if (b.y > PHYSICS.maskEntryY) {
    b.enteredChannel = channelAtSlotRow(b.x);
    b.slotX = b.x;
    b.vx = 0;
    b.vy = Math.max(45, Math.min(500, b.vy));
    b.phase = 'catch';
  }
}

function drawLamps() {
  const lit = getLitCells();
  matrix.forEach((matrixRow, row) => {
    matrixRow.forEach((cellValue, col) => {
      if (!lit[row][col]) return;
      const left = lampX[col] - lampWidth / 2;
      const top = lampY[row] - lampHeight / 2;
      const gradient = ctx.createRadialGradient(lampX[col], lampY[row], 3, lampX[col], lampY[row], 28);
      gradient.addColorStop(0, '#fffbd8dd'); gradient.addColorStop(.42, '#ffe34a99'); gradient.addColorStop(1, '#ffd40000');
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, lampWidth, lampHeight); ctx.clip();
      ctx.fillStyle = gradient; ctx.fillRect(left, top, lampWidth, lampHeight);
      ctx.restore();
    });
  });
  if (state.hitColumns.length) {
    const blinkOn = Math.floor(performance.now() / 420) % 2 === 0;
    state.hitColumns.forEach((col) => {
      if (!blinkOn) return;
      const left = lampX[col] - prizeWidth / 2;
      const centerY = prizeTop + prizeHeight / 2;
      const glow = ctx.createRadialGradient(lampX[col], centerY, 4, lampX[col], centerY, 34);
      glow.addColorStop(0, '#fff8c7a8');
      glow.addColorStop(.48, '#ffe36c5c');
      glow.addColorStop(1, '#d99d1600');
      ctx.save();
      ctx.beginPath(); ctx.rect(left, prizeTop, prizeWidth, prizeHeight); ctx.clip();
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = glow;
      ctx.fillRect(left, prizeTop, prizeWidth, prizeHeight);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = '#ffe89a'; ctx.globalAlpha = .72; ctx.lineWidth = 2;
      ctx.strokeRect(left + 1, prizeTop + 1, prizeWidth - 2, prizeHeight - 2);
      ctx.restore();
    });
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height); drawLamps();
  if (!state.ball) return;
  const b = state.ball;
  const gradient = ctx.createRadialGradient(b.x - 4, b.y - 5, 1, b.x, b.y, b.r);
  gradient.addColorStop(0, '#fff3c2'); gradient.addColorStop(.22, '#ffbd3f'); gradient.addColorStop(.62, '#f06a1c'); gradient.addColorStop(1, '#8f250c');
  ctx.save();
  ctx.shadowColor = '#0008'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#74200d'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  // Die Hintergrundgrafik wird in der 878×1238-Maschine als mittiger
  // 1254×1254-Ausschnitt gezeigt (Quellversatz 188/8). Derselbe originale
  // Bildausschnitt liegt hier nochmals vor der Kugel: Zacken, Konturen und
  // Zahlenquadrate bleiben dadurch pixelgenau und die Kugel rollt dahinter.
  if (catcherForeground.complete && catcherForeground.naturalWidth) {
    ctx.drawImage(catcherForeground, 151, 601, 620, 76, 152, 602, 620, 76);
  }
}

function frame(time) {
  const elapsed = Math.min((time - state.lastTime) / 1000 || 0, .05); state.lastTime = time; state.accumulator += elapsed;
  while (state.accumulator >= 1 / 120) { updateBall(1 / 120); state.accumulator -= 1 / 120; }
  draw(); requestAnimationFrame(frame);
}

let plungerArmed = false;
function pullPlunger(event) {
  if (playButton.disabled || plungerArmed) return;
  event.preventDefault();
  plungerArmed = true;
  if (state.active && state.waitingForShot) machine.classList.add('is-pulling');
  if (event.pointerId !== undefined) playButton.setPointerCapture(event.pointerId);
}
function releasePlunger(event, fire = true) {
  if (!plungerArmed) return;
  if (event) event.preventDefault();
  const strikesBall = state.active && state.waitingForShot && state.ball?.phase === 'loaded';
  plungerArmed = false;
  machine.classList.remove('is-pulling');
  if (fire) setTimeout(() => { if (strikesBall) metallicTing(); handlePlay(); }, 95);
}
playButton.addEventListener('pointerdown', pullPlunger);
playButton.addEventListener('pointerup', (event) => releasePlunger(event));
playButton.addEventListener('pointercancel', (event) => releasePlunger(event, false));
playButton.addEventListener('keydown', (event) => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) pullPlunger(event); });
playButton.addEventListener('keyup', (event) => { if (event.key === ' ' || event.key === 'Enter') releasePlunger(event); });
playButton.addEventListener('click', (event) => event.preventDefault());
withdrawButton.addEventListener('click', openPayout);
autoplayButton.addEventListener('click', () => setAutoplay(!state.autoplay));
depositButton.addEventListener('click', openDeposit);
depositAmounts.addEventListener('click', (event) => { const amount = Number(event.target.closest('[data-amount]')?.dataset.amount); if (amount) createDeposit(amount); });
async function copyInvoice() {
  if (!currentInvoice) return;
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(currentInvoice); copied = true;
    } else {
      invoiceText.focus(); invoiceText.select(); invoiceText.setSelectionRange(0, invoiceText.value.length);
      copied = document.execCommand('copy');
    }
  } catch { copied = false; }
  copyInvoiceButton.textContent = copied ? 'Copied' : 'Select invoice';
  invoiceStatus.textContent = copied ? 'Invoice copied' : 'Copy blocked by browser';
  if (!copied) { invoiceText.focus(); invoiceText.select(); }
  setTimeout(() => { copyInvoiceButton.textContent = 'Copy invoice'; }, 1500);
}
copyInvoiceButton.addEventListener('click', copyInvoice);
depositModal.addEventListener('close', () => window.clearInterval(depositPoll));
pastePayoutButton.addEventListener('click', pastePayoutInvoice);
scanPayoutButton.addEventListener('click', () => payoutImage.click());
payoutImage.addEventListener('change', () => scanPayoutImage(payoutImage.files?.[0]));
submitPayoutButton.addEventListener('click', submitPayout);
copyPayoutLnurlButton.addEventListener('click', copyPayoutLnurl);
payoutModal.addEventListener('close', () => window.clearInterval(payoutPoll));
soundToggle.addEventListener('click', () => { state.sound = !state.sound; soundToggle.textContent = state.sound ? 'Ton an' : 'Ton aus'; soundToggle.setAttribute('aria-pressed', String(state.sound)); if (state.sound) tone(440, .07, .02, 'triangle'); });
updateUI(); loadGuestBalance(); requestAnimationFrame(frame);
