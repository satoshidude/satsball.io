import { decodeInvoice } from '@getalby/lightning-tools/bolt11';

export function decodeWholeSatInvoice(rawInvoice, currentTime = Math.floor(Date.now() / 1000)) {
  const invoice = String(rawInvoice || '').trim().replace(/^lightning:/i, '');
  if (invoice.length < 40 || invoice.length > 5000) throw new Error('Invalid Lightning invoice');
  let decoded;
  try { decoded = decodeInvoice(invoice); }
  catch { throw new Error('Invalid Lightning invoice'); }
  const paymentHash = decoded?.paymentHash;
  const millisatoshis = decoded?.millisatoshi ? BigInt(decoded.millisatoshi) : 0n;
  if (!paymentHash || millisatoshis <= 0n || millisatoshis % 1000n !== 0n) throw new Error('Invoice must specify a whole-sat amount');
  const expiresAt = Number(decoded.timestamp) + Number(decoded.expiry || 3600);
  if (expiresAt <= currentTime) throw new Error('Lightning invoice has expired');
  const amount = Number(millisatoshis / 1000n);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid invoice amount');
  return { invoice, paymentHash, amount };
}
