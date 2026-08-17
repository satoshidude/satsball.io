const el = (id) => document.getElementById(id);
const sats = (value) => `${new Intl.NumberFormat('de-DE').format(value)} sats`;
const number = (value) => new Intl.NumberFormat('de-DE').format(value);
const percent = (value) => new Intl.NumberFormat('de-DE', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);

function render(data) {
  const { traffic, games, money, security } = data;
  el('deposits').textContent = sats(money.deposits);
  el('withdrawals').textContent = sats(money.withdrawals);
  el('outstanding').textContent = sats(money.outstanding);
  el('ggr').textContent = sats(money.houseEarnings);
  el('rtp').textContent = percent(games.rtp);
  el('rtpBar').style.width = `${Math.min(100, games.rtp * 100)}%`;
  el('payouts').textContent = sats(games.payouts);
  el('stakes').textContent = sats(games.stakes);
  el('netEarnings').textContent = sats(money.netEarningsMsat / 1000);
  el('fees').textContent = sats(money.feesMsat / 1000);
  el('rounds').textContent = `${number(games.roundsCompleted)} / ${number(games.roundsStarted)}`;
  el('winningRounds').textContent = number(games.winningRounds);
  el('losingRounds').textContent = number(games.losingRounds);
  el('visitors').textContent = number(traffic.visitors);
  el('visitorsOnly').textContent = number(traffic.visitorsOnly);
  el('players').textContent = number(traffic.players);
  el('visitorsToday').textContent = number(traffic.visitorsToday);
  el('pageviews').textContent = number(traffic.pageviews);
  const balanced = money.reconciliationDifference === 0 && money.ledgerDifference === 0 && !security.payoutsPaused;
  el('audit').textContent = security.payoutsPaused
    ? `Auszahlungen pausiert: ${security.pauseReason || 'manuelle Prüfung erforderlich'}`
    : balanced
      ? 'Bilanz und Ledger stimmen: Zahlungsfluss, Guthaben und Spielergebnis sind vollständig abgestimmt.'
      : `Abweichung: Buchhaltung ${sats(money.reconciliationDifference)}, Ledger ${sats(money.ledgerDifference)} – Buchungen prüfen.`;
  el('audit').className = `audit ${balanced ? 'is-balanced' : 'is-off'}`;
  el('daily').innerHTML = data.daily.length ? data.daily.map((day) => `<tr>
    <td>${day.day.split('-').reverse().join('.')}</td><td>${number(day.visitorsOnly)}</td><td>${number(day.players)}</td><td>${number(day.completed)} / ${number(day.rounds)}</td>
    <td>${sats(day.stakes)}</td><td>${sats(day.payouts)}</td><td>${percent(day.stakes ? day.payouts / day.stakes : 0)}</td><td>${sats(day.ggr)}</td>
  </tr>`).join('') : '<tr><td colspan="8">Noch keine Daten.</td></tr>';
  el('updated').textContent = `aktualisiert ${new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' }).format(new Date(data.generatedAt))}`;
}

async function refresh() {
  try {
    const response = await fetch('/api/monitoring', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch {
    el('updated').textContent = 'Daten nicht erreichbar';
    document.querySelector('.live i').style.background = '#d54a2b';
  }
}

refresh();
window.setInterval(refresh, 30000);
