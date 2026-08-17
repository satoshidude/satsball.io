![Satsball — Three balls. One winning column. Real sats.](satsball-social-card-v2.png)

# Satsball - Three balls. One winning column. Real sats over Lightning!

Satsball is a browser-based mechanical ball game with real Bitcoin Lightning deposits and withdrawals. A game costs 10 sats, contains three balls, and settles its result against a server-side balance and append-only ledger.

## Payments

- Anonymous browser sessions receive a server-managed balance.
- Deposits create Lightning invoices through a Nostr Wallet Connect (NWC) wallet.
- A settled invoice is credited exactly once and rotates the session token.
- Withdrawals support Lightning invoices and LNURL-withdraw.
- Configurable per-transaction and daily limits constrain deposits and withdrawals.
- Payment states, fees, reserved funds, retries, and reconciliation data remain on the server.

The browser animation only visualizes a result. Stakes, outcomes, payouts, balances, and payment settlement are determined and recorded server-side.

## Self-hosting

Requirements: Node.js 22+, npm, an HTTPS reverse proxy, and an NWC connection with invoice and payment permissions.

```bash
git clone https://github.com/satoshidude/satsball.git
cd satsball
npm ci
cp config.example.md config.md
npm test
npm run dev
```

Edit the private, ignored `config.md`:

```dotenv
RIZFUL_NWC_URI=nostr+walletconnect://...
MONITORING_USER=operator
MONITORING_PASSWORD=replace-with-a-long-random-password
```

Development defaults to `http://0.0.0.0:5173`. In production, bind to localhost behind HTTPS, set `PUBLIC_ORIGIN`, and keep the writable data directory outside the repository:

```bash
PORT=3432 \
HOST=127.0.0.1 \
PUBLIC_ORIGIN=https://satsball.example.org \
DATA_DIR=/var/lib/satsball \
npm run dev
```

Relevant optional limits include `MAX_DEPOSIT_SATS`, `DAILY_DEPOSIT_LIMIT_SATS`, `MAX_WITHDRAWAL_SATS`, `DAILY_WITHDRAWAL_LIMIT_SATS`, `WITHDRAWAL_BASE_FEE_SATS`, and `WITHDRAWAL_FEE_BPS`.

Example Caddy and systemd configurations are available in [`deploy/`](deploy/). The protected monitoring dashboard is served at `/monitoring/` when a monitoring password is configured.

## License

Licensed under the [MIT License](LICENSE).
