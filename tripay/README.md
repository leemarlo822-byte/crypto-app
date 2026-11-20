# TriPay — USD payment request starter

A deployable Node.js/Express + Supabase starter for **USD payment requests**. Merchant creates a request and shares a URL. Customer selects:

- **Visa / Mastercard** via **Paystack hosted checkout** (subject to merchant approval for USD collection in Kenya). Cardholders may be asked for bank-approved passkey / biometric / 3-D Secure authentication; the app does **not** control or collect their passkeys.
- **Crypto** via **NOWPayments hosted invoice**. Provider displays the *real, network-specific* payment address and amount; backend listens for a verified `finished` IPN before marking paid.
- **Bank** via **Stripe Checkout with US ACH** only if you have an eligible Stripe merchant account and webhook configured, **or** manually confirmed wire/bank transfer instructions otherwise. For manual bank transfers an admin must independently verify that the money actually cleared before marking the invoice paid.

This is a payment-collection application, **not** a crypto custody platform or crypto wallet ledger. It does not create persistent per-user crypto addresses or process withdrawals. Add customer accounts, legal compliance, custody provider, reconciled balances and withdrawal controls separately if that is your goal.

## 1. Prerequisites

- Node.js 20+
- Supabase project and its API keys
- One Supabase Auth user with email/password for your merchant administrator
- Merchant accounts, due diligence and working API keys for the providers you want to offer
- HTTPS domain, e.g. a Render Web Service

## 2. Database

In your **new or existing Supabase project**, run `schema.sql` in the SQL Editor. The table is called `public.payment_requests` and has RLS enabled **with no public policies**. Only your backend Supabase service role reads it. Do **not** expose the service role key in any frontend file.

In Supabase Auth, create/verify the admin login email; set the same email in `ADMIN_EMAIL`. For a production site, enable MFA on admin accounts; this sample only uses email/password authentication.

## 3. Setup

```bash
cp .env.example .env
npm install
npm run check
npm start
```

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `MERCHANT_NAME`, and `APP_URL` (e.g. `http://localhost:10000` locally, `https://your-app.onrender.com` in production).

Visit `http://localhost:10000/admin`, sign in, create a USD request and send the generated `/pay/<uuid>` link to a customer. You can use the **Email link** button (opens the user's own email client) or **Copy link**; this starter does not independently send email or SMS.

## 4. Payment provider setup

### Paystack — Visa / Mastercard

1. Register an eligible merchant account in Kenya and complete KYB. Request/activate **USD international card payments** (not automatically enabled for everyone).
2. Obtain test/live `PAYSTACK_SECRET_KEY`. The frontend never receives it.
3. In your Paystack dashboard set the webhook URL to `https://YOUR_DOMAIN/api/webhooks/paystack`.
4. Complete test-mode transactions and verify webhook and exact USD amount before using live keys.
5. Confirm settlement bank account eligibility and currency with Paystack. Real USD settlement typically requires a qualifying Kenya domiciled USD account.

Docs: https://paystack.com/docs/payments/accept-payments/ and https://paystack.com/docs/payments/webhooks/

### NOWPayments — Crypto

1. Register, finish provider verification and configure **your own receiving wallet addresses** in the merchant's NOWPayments dashboard.
2. Configure `NOWPAYMENTS_API_KEY` and `NOWPAYMENTS_IPN_SECRET` (IPN secret is distinct from API key).
3. Backend creates a hosted invoice with a unique `order_id`; NOWPayments displays its payable address, amount and network on the hosted page. The app does **not** invent wallet addresses.
4. NOWPayments calls `https://YOUR_DOMAIN/api/webhooks/nowpayments`; this code checks its signed SHA-512 notification and requires `finished`.
5. Test supported coins, chain selection, invoice callback payloads, underpayments, expired invoices and transaction confirmations before any live payments. Contact NOWPayments to confirm your merchant eligibility and any supported currencies/networks.

Docs: https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description and https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389-IPN-and-how-to-setup

### Bank — ACH or manual transfer

**US ACH**: Configure **both** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for a Stripe account genuinely approved for US bank account/ACH payments. Configure webhook URL `https://YOUR_DOMAIN/api/webhooks/stripe`, subscribing to `checkout.session.completed`, `checkout.session.async_payment_succeeded` and (for later failure handling) `checkout.session.async_payment_failed`. The backend marks paid **only when Stripe reports the payment status is `paid`**, never just on page redirect. ACH may take days and remains subject to returns. A Kenya-based merchant cannot assume US ACH access; confirm with your merchant provider first.

**Manual bank/wire**: When Stripe ACH is not configured, set the real `BANK_ACCOUNT_NAME`, `BANK_NAME`, `BANK_ACCOUNT_NUMBER`, `BANK_SWIFT` and optional routing, branch, notes. Only use a business bank account you actually control. Customers see verified bank instructions and a unique reference. Admin may click **Confirm verified transfer** after reconciling the actual bank statement. This method is not an automatic bank debit and does **not** invoke a passkey.

Stripe docs: https://stripe.com/payments/us-bank-payments

## 5. Deploy to Render

1. Push this folder to a private GitHub repository (do **not** push `.env`).
2. In Render create **Web Service** from that repository, set Runtime to **Node**.
3. Build command: `npm install`; start command: `npm start`.
4. Add your environment variables in Render's secure Environment panel; set `NODE_ENV=production` and `APP_URL=https://YOUR_RENDER_DOMAIN`.
5. Deploy, load `/api/health`, test `/admin`, and update each provider's webhook URL.
6. Run several sandbox/test transactions and confirm correct amount, currency, signed webhook, payment status and merchant settlement **before** enabling live funds.

## Security and production checklist

- Never ask customers for bank passwords, card PINs, recovery phrases, private keys or raw passkeys. Authentication belongs to the provider / their issuer.
- The backend never stores card data, bank login details or private crypto keys. Use provider-hosted checkout and correct HTTPS links.
- The public status page is deliberately limited to a random UUID request; do not put patient, identity or other sensitive information in the invoice description.
- Supabase table has RLS enabled and no browser-readable policies; keep service credentials server-side.
- Webhooks are authenticated and updates are conditional/idempotent; amount and currency are checked where the provider supplies them.
- **Starter limitations:** needs provider sandbox testing (NOWPayments invoice/IPN payload formats in particular), reconciliation for missed webhooks, payment attempt logging and expiry/retry workflows, database-level serialization for concurrent checkout attempts, bank return/chargeback handling, refund/dispute handling, monitored audit logs, admin MFA, anti-fraud, compliance and legal review before production usage. The manual bank confirmation is a merchant attestation, not a connection to bank transaction feeds. Do not use this starter for holding customer deposits, investments or crypto custody without separately designed safeguards and applicable licensing.
- Card/bank/crypto provider onboarding, KYC/KYB and legal approval may restrict payment methods, especially when operating from Kenya with US customers.

## API summary

| Endpoint | Role |
|---|---|
| `POST /api/admin/login` | Admin login (HttpOnly cookie) |
| `GET /api/admin/requests` | List requests (admin) |
| `POST /api/admin/requests` | Create a payment request (admin) |
| `GET /api/requests/:id` | Public request status and available methods |
| `POST /api/requests/:id/checkout` | Start provider checkout for a single method |
| `POST /api/webhooks/paystack` | Verify signed Paystack success and server-verified amount |
| `POST /api/webhooks/nowpayments` | Verify signed crypto IPN and final status |
| `POST /api/webhooks/stripe` | Verify Stripe webhook and paid status |
| `POST /api/admin/requests/:id/confirm-bank` | Admin bank statement reconciliation |

**A customer's payment is never successful merely because they open the checkout or complete a login/passkey step.** The provider must indicate actual payment completion, or the merchant must verify their own bank deposit.
