# Globie Keeper

> One person fronts a shared cost — a dinner, rent, groceries, a trip, a group buy — the group splits
> it on their phones, and every share is paid in USDC on NEAR straight to the person who paid — the
> server never holds the money.

**Demo:** <https://near-keeper.globie.ai> · **Video:**
[demo/globie-keeper-demo.mp4](demo/globie-keeper-demo.mp4) (2 min 17 s, 15 beats end to end)
· **Tracks:** `social`, `realworld`, `business` · **Support:**
[`globieearth.near`](https://nearblocks.io/address/globieearth.near)

---

## Built during the hackathon

Globie Keeper is new — it has never shipped, and it was written inside hackathon windows rather than
maintained beforehand. It is inspired by our own problem: the reimbursement bottleneck our team,
friends and family keep hitting. The same concept was entered in an earlier AI hackathon on a
different settlement rail, with a narrower feature set. This submission is the NEAR build: payment
and identity were rebuilt from scratch on NEAR — wallet sign-in, `lib/near.ts`,
`lib/near-settlement.ts`, `routes/near.ts`, transaction verification, tips on the NEAR rail, the
agreement registry contract (`globie-reg.testnet`), split-mode voting, the one-tap `/pay` page,
Globie Fund, the Sputnik DAO adapter, minting a DAO through the Sputnik factory, and migrations
012–023. None of the earlier rail remains: settlement and sign-in here are NEAR-only, and nothing of
ours is deployed on another chain. The Expo shell, schema, receipt split and Globie agent carry over
from the earlier build; the NEAR rail is what this window added.

Stock, permissive libraries throughout — Expo, React Native, Fastify, React Query, pg-boss,
PostgreSQL — no vendored template.

Provenance follows [HACKATHON.md](https://nearhackathon.com/HACKATHON.md): Q-001 sets the window at
the 19 Oct 2026 announcement; Q-002 covers the same concept entered on another chain, and the
first paragraph of this section names that entry; Q-003 wants the window's work reachable on its own
— a dedicated branch, or a `pre-hackathon` → `hackathon-submission` tag pair with a link in this
section.

## Concept

**The problem.** One person fronts a shared cost — a team lunch, a client's taxi, rent, a group buy.
Everyone else owes them a small, awkward amount. The money is real, the IOUs are not: they live in
chat screenshots and a spreadsheet, and someone has to chase four people for 355 THB each.

**The idea.** Make the person who paid the payee. The app turns the receipt into one exact invoice per
person — same currency as the bill, converted once to a stablecoin at a frozen rate — and gives every
member a single amount, a named NEAR account, and a memo. Paying stops being a negotiation and becomes
one transfer.

**Why on a chain.** A 355 THB share is small enough that fees decide whether splitting is worth it. A
NEP-141 transfer settles in about a second for a fraction of a cent, the payee is a readable
`name.testnet` instead of a hex address, and the receipt is public on an explorer — so the person who
is owed money, and a judge, can both check a payment without trusting the operator.

**The rule that makes it credible.** The server holds no key and no funds. It freezes a quote, hands
the payer's own wallet an unsigned transaction, then reads the transaction back from RPC and accepts
it only if token, sender, receiver and amount all match. A wrong amount is a `409`, not a silent
ledger move. The same standard applies to agreement consent and to group payouts: a row in our
database is never the proof — a transaction is.

**Who it is for.** Small teams, flat shares, freelancers and friends: groups that already have a
group chat and a person who keeps paying the bill.

Money and billing are sensitive topics. Our proudest achievement is shipping a working product that
clears those bottlenecks for our team and for anyone else who needs it, while preserving trust and
keeping the relationships around it strong and positive.

---

## What it does

Splitting a bill is easy until someone has to chase four friends for 355 THB each. Globie Keeper
makes the person who fronted the table the payee, and gives everyone else a single, exact amount to
send. A receipt is photographed and split with integer arithmetic (`sum(shares) == bill.total`), each
member confirms only their own lines, and payment then moves on a rail the payer controls.

On the NEAR rail the payer signs a NEP-141 `ft_transfer` in their own wallet. The server never signs
and never custodies: it reads the transaction back from RPC and accepts it only if the token, sender,
receiver and amount all match the share. A wrong amount is a `409`, not a silent ledger move.
Settlement awards Globie points to the person who paid first — the only reward in the app that is
expensive to fake, because it is derived from verified payments.

Agreements are held to the same standard. Before anyone is asked for money the terms are frozen into
a canonical snapshot and hashed, and each member accepts them in two possible strengths: **signed**,
a NEP-413 message from their own wallet that proves the key and costs no gas, or **anchored**, where
the same signature is published on chain as evidence. Anchoring has two paths — each member can
write their **own** row into one shared registry contract (`record_acceptance`, so nobody can fake
somebody else's acceptance), or the fronter can publish the terms digest with a single read-only
token call. Either way the proof is a public transaction, not a row in our database.

How a bill divides is also a member decision: the group votes `equal` or `itemised`, per agreement
and per bill, by majority with the fronter breaking ties, and the winning mode is applied when the
bill is finalised.

**The 60-second path a judge should take:**

1. Open <https://near-keeper.globie.ai> (or `npm start`, then the web target on
   `http://localhost:8081`).
2. Sign in with a NEAR wallet (NEP-413 signed message). No seed phrase, no faucet at this step.
   Pick Meteor, Nightly or Sender — there is no email or password route.
3. Open the seeded group, accept the agreement, open the bill. Confirm your line; the last
   confirmation finalises the bill.
4. Link a NEAR account on both sides — `PATCH /api/near/account` with `{"nearAccount":"you.testnet"}`.
5. As the fronter: `POST /api/shares/:id/request-transfer` returns `payTo`, `chainAmount` and the
   memo `globie:<shareId>`.
6. Send that exact amount of the configured NEP-141 token with `ft_transfer`, carrying the memo.
7. As the payer: `POST /api/shares/:id/settle` with `{"txHash":"…"}`. The share flips to `paid`,
   Globie points are awarded, and the response carries the explorer link.

An **anchored** agreement adds one visible step: after signing, each member taps **Record** on their
own row in the *Proof* panel, which mints a `record_acceptance` transaction for their wallet to sign
and returns a hash anyone can open on the explorer.

Steps 4–7 also exist in the Expo client: link the account in **Settings**, the fronter taps
**Request on NEAR** on the bill, and the payer pastes the transfer hash under **Pay on NEAR** on
*Shares*. Sign-in itself is a NEP-413 signed message, so the wallet proves the account before any
transfer. The same steps work over HTTP — `npm run api:verify:near -- <TX_HASH> <SENDER.near>`
re-checks step 6 independently of the app.

Two things leave the app for people who are not in it: `GET /api/bills/:id/export.csv` writes one row
per share with its frozen quote and transfer hash, and `POST /api/shares/:id/pay-link` mints a
bearer token for `/pay/<token>` — a page that shows that one share's amount, payee and memo **with no
session**, so a payer who will not install anything can still read what to send. The link is
read-only; the ledger moves only when a verified transfer comes back through the signed-in flow.

## Features

Everything below is implemented in this repository. The recording walks the split → pay → AI → Fund
→ DAO path; the **Where** column names the screen and the API route behind each item, so nothing here
is a promise without code.

### Split the bill

| Feature | What it does | Where |
|---|---|---|
| Vision receipt parse | Photograph a receipt; a vision model returns line items, quantities and a total, which stay editable | Bill screen · `POST /bills/:id/media`, `POST /bills/:id/parse` |
| Integer-exact split | All money is integer minor units and `allocate()` distributes the remainder, so the shares sum exactly to the total — no floating-point drift | `server/src/lib/money.ts` |
| Itemised or equal | The group votes `equal` vs `itemised` per agreement and per bill, majority with the fronter breaking ties | `POST /agreements/:id/split-vote`, `POST /bills/:id/split-vote` |
| Per-member confirmation | Each member claims only their own lines; the last confirmation finalises the bill and freezes the shares | `PATCH /bills/:id/claims`, `POST /bills/:id/finalize` |
| Multi-currency | A bill keeps its own currency (THB, USD, EUR…); FX is quoted at request time, never guessed at render time | `GET /fx/rates` |
| Late fees | An optional per-agreement late fee accrues into interest charges that can themselves be settled on chain | `POST /bills/:id/interest`, `POST /interest/:id/settle` |
| CSV export | One row per share with frozen quote, payee and transfer hash, for whoever keeps the books | `GET /bills/:id/export.csv` |

### Get paid on NEAR

| Feature | What it does | Where |
|---|---|---|
| Wallet login | NEP-413 signed message — no password, no email, no seed phrase typed into the app | `/near/login` · `POST /auth/near/nonce`, `POST /auth/near/verify` |
| One-tap payment | Sign in once, then a single button builds the `ft_transfer` and the wallet signs it | `/pay/<token>` · `POST /near/ft-transfer` |
| Frozen quote | The exact token amount is frozen on the share, with payee and memo `globie:<shareId>`, so the price cannot move mid-payment | `POST /shares/:id/request-transfer` |
| Verified settlement | The server reads the tx back from RPC and accepts only matching token / sender / receiver / amount; replay-safe and advisory-locked | `POST /shares/:id/settle`, `server/src/lib/near.ts` |
| Pay link without an account | A forwardable `/pay/<token>` page shows amount, payee, contract and memo with no sign-in, and the same page can pay in one tap after sign-in | `POST /shares/:id/pay-link`, `GET /api/pay/:token` |
| Native NEAR too | Transfers can be native NEAR as well as a NEP-141 token | `POST /near/native-transfer` |
| Tips on the same rail | A payer can tip the fronter, settled by the same verifier | `POST /bills/:id/tips`, `POST /tips/:id/settle` |
| Globie points | Points are awarded only from verified settlements, so the reward is expensive to fake | `GET /me/points` |

### Prove the agreement

| Feature | What it does | Where |
|---|---|---|
| Canonical terms | Before anyone is asked for money the terms are frozen into a canonical snapshot and hashed | `POST /agreements` |
| Signed consent | A free NEP-413 signature proves the member's key without spending gas | `POST /agreements/:id/accept` |
| Anchored consent | Each member writes **their own** row into a shared registry contract, so nobody can fake somebody else's acceptance | `POST /near/record-acceptance`, [contracts/agreements](contracts/agreements/src/lib.rs) |
| Fronter anchor | Alternatively the fronter publishes the terms digest with a single read-only token call | `POST /agreements/:id/anchor`, `POST /near/anchor-call` |
| Consent ledger | Anyone can read who accepted what, and in which strength | `GET /agreements/:id/acceptances`, `GET /agreements/:id/consent` |

### Ask Globie (AI)

| Feature | What it does | Where |
|---|---|---|
| Natural-language questions | Ask "who still owes?" or "how much has been collected?" and Globie answers from the live bill, not from a prompt preamble | Group chat · `POST /agent/chat` |
| Eight grounded tools | `parse_receipt_media`, `propose_allocation`, `request_item_confirmation`, `create_payment_request`, `get_bill_status`, `send_reminder`, `award_points`, `explain_feature` | `POST /agent/message`, `GET /agent/tools` |
| Confirmation gate | Tools that move money or message people (`create_payment_request`, `send_reminder`, `award_points`) require an out-of-band confirmation token | `server/src/lib/agent.ts` |
| Reminder tones | Friendly, firm or final, composed from the share's real due date | `server/src/lib/notify.ts` |
| In-app manual | Twenty help topics, one per surface: sign-in, wallets, testnet, pay links, late fees, bounties, creating and connecting a DAO, the Fund, and the agent's limits. The text is server content, so it ships with the API | `/help` · `GET /api/help`, [help.ts](server/src/lib/help.ts) |
| Model choice | NEAR AI Cloud, OpenAI-compatible; vision and chat models are separate env vars | `NEAR_AI_API_KEY`, `VISION_MODEL`, `AGENT_MODEL` |

### Globie Fund

| Feature | What it does | Where |
|---|---|---|
| Adopt a tree | A short list of real planting projects with an urgency label, priced in fixed chips | `/fund` · `GET /fund/projects` |
| Quote, then pay | `$5 / $10 / $25 / $50` in NEAR or USDC freezes a quote that stays valid for its TTL | `POST /fund/quote` |
| Deed, not a receipt | A verified gift writes a deed `GLB-2026-000NNN` with an explorer link; the tx hash is the deed's identity | `POST /fund/settle`, `GET /fund/deeds` |
| One transfer, one deed | Settlement is idempotent on the tx hash and again on the quote, so a replay answers `alreadySettled` instead of minting a second deed | `server/src/lib/fund.ts` |
| Living Deed sync | Best-effort sync to `mcp.globie.earth/adopt_species`, keyed by the tx hash so one transfer cannot mint two deeds | `MCP_GLOBIE_EARTH_URL` |

### Group DAO

| Feature | What it does | Where |
|---|---|---|
| Connect a real DAO | Reads a deployed Sputnik DAO V2's `get_policy`; nothing is rebuilt and no multisig is forked | `POST /groups/:groupId/treasuries` |
| Create a DAO | A group with no DAO yet gets the factory's own `create`: the server encodes it, the member's wallet signs, and the wallet pays the storage deposit | `POST /groups/:groupId/treasuries/create`, `POST /groups/:groupId/treasuries/create/confirm` |
| Funded before signing | Prices the call — 6 NEAR deposit plus gas at the current price — against the signer's liquid balance, so an empty wallet gets `409 insufficient_near_balance` with the shortfall instead of a raw RPC string | `server/src/lib/sputnik.ts` |
| Human-readable policy | Turns a role's threshold into "2 of 3 council", so the screen can say how many signatures a payout needs | `server/src/lib/sputnik.ts` |
| Bounty lifecycle | Post → claim → submit → decide → payout preview → payout → tx → sync | `POST /groups/:groupId/bounties`, `POST /bounties/:id/*` |
| Wallet-ready proposals | Builds unsigned `add_proposal` / `act_proposal` transactions; the member's wallet signs, the server never does | `POST /bounties/:id/payout` |
| NEAR or USDC payouts | Proposals are either a native `Transfer` or a `FunctionCall` to `ft_transfer` on the token contract | `server/src/lib/sputnik.ts` |
| Treasury sync | Reads the DAO back after execution so the board shows the executed amount and proposal id | `POST /payouts/:id/sync`, `POST /treasuries/:id/sync` |
| Reputation surfaces | Contributor list, trust list and a hero board built from settled payments | `GET /groups/:groupId/trust`, `/groups/[id]/leaderboard` |

#### Minting a DAO from the board

A new group starts without a treasury, so the board carries a *Create a DAO with defaults* card next
to *Connect a DAO*. Both are owner/fronter only, and the create card disappears once a treasury is
registered; either path ends in the same `dao_treasuries` row.

1. `POST /api/groups/:groupId/treasuries/create` with `{"name":"market-day","label":"Market day"}`
   returns an unsigned transaction, the account the factory will mint
   (`market-day.sputnikv2.testnet` on testnet, `market-day.sputnik-dao.near` on mainnet), the factory
   account and the deposit as a yocto string. The name is a bare label — lowercase letters, digits
   and single `-`/`_` separators, no dots — and the council is the group's owner and fronters' linked
   NEAR accounts plus the signer, because a DAO whose council is empty can never approve a payout.
2. The wallet signs and pays. The cost is about 6.03 NEAR: a 6 NEAR storage deposit, which the
   factory refunds down to what the DAO code actually stores, plus roughly 0.03 NEAR of gas at a
   normal price. Keep about 6.3 NEAR liquid so a gas spike does not strand the click. The server
   prices the call against the signer's balance *before* the wallet opens — an underfunded account
   gets `409 insufficient_near_balance` naming the account, the balance and the shortfall, instead of
   the wallet's raw "Sender … does not have enough balance" string.
3. `POST /api/groups/:groupId/treasuries/create/confirm` with the minted account polls `get_policy`
   (four attempts, 1.5 s apart) and only then stores the treasury. "The transaction landed" and "the
   DAO answers `get_policy`" are different facts, and a treasury that cannot be read cannot be paid
   from; while the poll runs the card says *Waiting for …* with a **Check again** button.
4. The call is `create` on the factory with `{"name":"<label>","args":"<base64>"}`, where the decoded
   args are `{"config":{"name":"…","purpose":"…","metadata":""},"policy":["<account>", …]}`.
   `metadata` is a `Base64VecU8`, so an empty string is the empty blob, and a bare account list for
   `policy` is Sputnik's `VersionedPolicy::Default`: it expands to the standard `all` and `council`
   roles, a majority vote policy, a 1 NEAR proposal bond and a 7-day proposal period. By hand, the
   same call carries 6 NEAR and 300 Tgas.

Minting needs the wallet popup, so it works in the browser build only. On a phone the card says so:
open the web app, or create the DAO in a builder such as Trezu and paste its account into *Connect a
DAO* — a Trezu vault in front of a Sputnik DAO reads the same way. The in-app manual
(`/help` → *Creating your own DAO account*, served by `GET /api/help`) carries the same wording and
links back to the board.

### Groups, identity and platform

| Feature | What it does | Where |
|---|---|---|
| Groups with an agreement | Every group keeps its own terms, split mode, late fee and treasury | `/groups/[id]` |
| Invite code and QR | Join by a six-character code or by scanning the fronters' QR | `POST /groups/join`, `/scan`, `/join` |
| Activity feed | A single timeline of shares, payments, reminders, tips and deeds | `/me/activity` · `GET /me/activity` |
| Public board | Read-only board for people outside the group | `GET /public/board` |
| Notifications | Per-category preferences plus push-token registration | `PATCH /me/notifications`, `POST /me/push-token` |
| One client, web and native | Expo Router SPA that also builds for iOS and Android from the same routes | `app/` |
| Background jobs | Reminders and an outbox on pg-boss, so a settled share never depends on a request being open | `server/src/jobs` |

---

## Demo

The recording is [demo/globie-keeper-demo.mp4](demo/globie-keeper-demo.mp4) — **138 s, 720×1746,
30 fps**, a portrait phone view with burned-in beat captions. It was captured from one live browser
session against the testnet deployment over the Chrome DevTools Protocol, so every number on screen
came from the API; a title card, the captions and a recap card were added in editing.

| Time | What is shown |
|---|---|
| 0:00 | Title card: split votes, bills and shares, Globie AI, the DAO, the Fund |
| 0:03 | Home as `globie-alice-61576.testnet` — what you owe, what's open, 15 Globie — then *Start a group* (name, THB, tags) and *Join with a code* |
| 0:15 | *Dinner at Somtam House*: invite `DFMBDE` + QR, 4 members, agreement `≈ $30.14 / THB 1,020.00`, 3 of 4 accepted |
| 0:29 | **Split vote** as Chai: `By line item · 3` / `Evenly · 0`, one vote per member, majority wins — `Vote counted` |
| 0:41 | **Ask Globie**: "who still owes?" runs a live tool call — `Chai still owes 320.00 THB. Your share is settled since you fronted the cost.` A typed "how much do I owe?" answers `You owe nothing. Your share is settled. Chai owes 320.00 THB.`, then *Nudge the late payer* → Confirm → reminder sent |
| 1:07 | Back on *Dinner at Somtam House* — who is in, the agreement and the group chat |
| 1:12 | **Globie points and the leaderboard** over 30 days — Alice Hero 15 Globie (≈ $30.14 fronted), Ben 10, Chai 0, calmdish 0 |
| 1:18 | **The bill**: 5 line items, per-item shares, `Request on NEAR` with the frozen USDC quote |
| 1:26 | **Activity**: every event on one timeline; `Verified on chain` expands to the full transaction hash |
| 1:32 | **Globie Fund**: adopt a Yang Na for $5.00, deed `GLB-2026-000004` |
| 1:46 | **The whole manual lives in-app**: what Globie can and cannot do, WalletConnect, group rules, security |
| 1:50 | **Settings**: NEAR account linked and `Verified on NEAR`, keys stay on the device |
| 1:54 | **Group DAO**: live Sputnik `globie-dao-test.testnet`, treasury, spend caps (`≈ $15.15 / ≈ $74 / ≈ $2.95`), policy `114/7/2026`, bounty board |
| 1:58 | **Bounty claim**: 1,200.00 THB bounty at 10.1846 NEAR, agreement `#7cf2f215`, status → *Claimed · Waiting for the council* |
| 2:05 | **Shares as Chai**: outstanding `≈ $9.46 / THB 320.00`, one tap to `Pay 9.46 USDC` |
| 2:16 | Recap: one group, one dinner, one real payout trail |

### Testnet accounts used in the demo

Four accounts under our control, created and funded for this recording. Every balance below is a
finality-`final` RPC read, not a mock.

| Account | Role | NEAR | USDC |
|---|---|---|---|
| `globie-alice-61576.testnet` | fronts the dinner, receives the USDC | 9.9994 | 24.46 |
| `globie-chai-61576.testnet` | votes on the split, owes the outstanding share | 10.0000 | 20.00 |
| `globie-ben-61576.testnet` | reimburses their share, then donates to the Fund | 9.9997 | 10.54 |
| `calmdish4898.testnet` | fourth member, joins by code | — | — |

`calmdish4898.testnet` is a real account in the group but moves no money in this cut, so it carries
no balance row. The three that do transact reconcile with the recorded events: Alice spent 5 USDC at
the Fund and received 9.46 from Ben; Ben started at 20 and sent 9.46; Chai's 20 is untouched, because
Chai's share is the one left outstanding on purpose — the cut ends on that pay button.

### Transactions to check

| Event | Hash |
|---|---|
| Member share paid (USDC) | [`3XEx8wML35Ws7B5qPFK5og6CMsTBM2Vub2kUcQTza7s3`](https://testnet.nearblocks.io/txns/3XEx8wML35Ws7B5qPFK5og6CMsTBM2Vub2kUcQTza7s3) |
| Fund gift, deed `GLB-2026-000004` | [`AzrU8Cwvc9GdWXf7RwzNNG8bjC9ntvxPQhyanowvDx9F`](https://testnet.nearblocks.io/txns/AzrU8Cwvc9GdWXf7RwzNNG8bjC9ntvxPQhyanowvDx9F) |
| DAO vote on proposal 1 | [`5RDExsFgGNPU2H94EzmLP7RRfc1Ryq2SFpuduNwieMHj`](https://testnet.nearblocks.io/txns/5RDExsFgGNPU2H94EzmLP7RRfc1Ryq2SFpuduNwieMHj) |

Two honest notes about the recording. The Meteor wallet popup itself is not captured, because
browsers refuse popups opened from a scripted origin; the on-chain legs were signed headlessly with
the same accounts and the pay page carries that beat on screen. And the recording predates in-app DAO
minting: the hosted demo has since been redeployed with it, so a group that has no treasury yet now
offers a *Create a DAO with defaults* card the video does not show — the bounty and payout beats are
unchanged. The bounty beat in this cut stops at *Claimed · Waiting for the council*; the executed
payout is the one in the transaction table above.

---

## Support the Fund

Globie Fund pays planting projects per tree adopted. The in-app *Adopt a tree* flow in this demo
settles on testnet (see `GLOBIE_FUND_TREASURY_ACCOUNT`). To support the environmental protection work
directly, the project's own NEAR account is:

```
globieearth.near
```

| | |
|---|---|
| Address | [`globieearth.near`](https://nearblocks.io/address/globieearth.near) — NEAR mainnet |
| From the CLI | `near send <your-account>.near globieearth.near 5` |
| From a wallet | Open any NEAR wallet and send NEAR to `globieearth.near` |

This is a plain transfer to the project — no checkout, no processor, no custody in between; the
transaction is the receipt. It is separate from the demo's testnet treasury, so a mainnet gift will
not appear in the `/fund` screen of the testnet build.

---

## How NEAR is used

| Item | Value |
|---|---|
| Network | `testnet` (the default in `.env.example`) |
| Contract | Payments are a NEP-141 token call; the token is whatever `NEAR_USDC_CONTRACT` points at. One contract of ours exists: the agreement registry at `NEAR_AGREEMENTS_CONTRACT` (`globie-reg.testnet` in the demo) |
| Explorer | <https://testnet.nearblocks.io> |
| Primitives | NEP-141 `ft_transfer` / `ft_transfer_call`, verified through RPC `tx`; NEP-413 message signing for login and for consent (no gas); a Rust registry contract using NEP-297 `EVENT_JSON` for per-member acceptance receipts; Sputnik DAO V2 `get_policy` / `add_proposal` / `act_proposal` plus the factory `create` that mints a DAO the signer funds; named `*.near` accounts for payee identity; server-side read-only verification and unsigned-transaction minting (no signing key on the server) |
| AI | Receipt photos and video frames are read by a vision model, and Globie's replies are written by a text model, both through NEAR AI Cloud (`cloud-api.near.ai`, OpenAI-compatible). `NEAR_AI_API_KEY` holds the key; `VISION_MODEL` / `AGENT_MODEL` pick the models |
| Why NEAR | A 355 THB share is small enough that fees decide whether splitting is worth it. NEAR settles in about a second for a fraction of a cent, accounts are human-readable (`friend.testnet`) rather than hex, and a receipt is readable on an explorer without custom tooling — so a judge can check a payment without trusting us |

What this build deliberately does **not** do, because claiming it would be false:

- **No escrow and no custody.** `lib/near.ts` reads chain state and mints unsigned transactions;
  the member's own wallet signs. The one contract we wrote, `contracts/agreements`, stores nothing
  but agreement acceptances — it holds no funds and has no access keys, so a compromised contract
  cannot move a member's money. Payments stay a NEP-141 transfer between two members' accounts.
- **NEAR Intents / 1Click is not wired.** `NEAR_INTENTS_BASE_URL` exists in `.env.example` as the
  slot for the cross-chain quote route; no route calls it. 1Click has no testnet deployment, so it
  would have to be exercised on mainnet with the 0.2% fee.
- **NEP-413 login verifies the account; a typed-in one is verified by its first transfer.** Signing
  in with a wallet proves the key and sets `near_verified` immediately; an account saved by hand in
  Settings stays unverified until a transfer from it settles a share
  ([near-settlement.ts](server/src/lib/near-settlement.ts#L233-L245)).
- **Sub-accounts / Function Call Keys are reserved, not exercised.** `members.near_subaccount` exists
  in [012_near_rails.sql](db/migrations/012_near_rails.sql) for the "agent may request, only the
  human's full-access key may move" split; the demo uses one account per member.

## Reproduce it

```bash
git clone <REPO_URL> && cd NearHackathon
npm install
npm --prefix server install
cp .env.example .env        # fill the values listed below
docker compose up -d db     # or: podman-compose up -d db
npm --prefix server run migrate
npm --prefix server run seed    # optional: one demo universe, invite code KHAOSI
npm run api:dev                 # Fastify on http://localhost:3001
npm start                       # Expo dev server
```

`docker compose up -d db` assumes a current Docker. On a host that only has rootless
`podman 3.4.4` — the machine the demo was recorded on — several of its commands are
broken and the stack is assembled by hand instead:

- `podman build`, `podman pod create` and `podman network create` all fail
  (`slirp4netns is not supported`). Images are made with `podman create` +
  `podman cp` + `podman commit`, and every container runs `--network=host`.
- `podman commit` drops the image `CMD`, so re-assert it:
  `--change 'CMD ["node","dist/index.js"]' --change 'WORKDIR /app'`.
- Containers cannot bind ports below 1024, so the web container listens on **8081**
  and the proxy forwards to it; `deploy/web.conf` says `listen 80`.
- Container-name DNS is unavailable; the proxy reaches services through
  `/etc/hosts` entries `127.0.0.1 api` and `127.0.0.1 web`.
- Host `node` is v12, which cannot parse the TypeScript toolchain. Run every Node
  command in a `node:22-alpine` container mounted at the repo root.

New agreements are `signed` (free NEP-413) by default. The **anchored** path needs the registry
contract: `cd contracts/agreements && cargo build --target wasm32-unknown-unknown --release`, deploy
that wasm to a testnet account you control, and set `NEAR_AGREEMENTS_CONTRACT` to it. Leave the
variable empty and the fronter's read-only token call stays the only anchor.

| Variable | Purpose | Required |
|---|---|---|
| `NEAR_NETWORK` | `testnet` or `mainnet`; selects the default explorer | yes |
| `NEAR_RPC_URL` | RPC endpoint the verifier reads transactions from | yes |
| `NEAR_USDC_CONTRACT` | NEP-141 token members pay with. Empty disables the rail (`409 near_not_configured`) | yes |
| `NEAR_USDC_DECIMALS` | Must equal the token's `ft_metadata().decimals` (6 for USDC) | yes |
| `NEAR_SERVER_ACCOUNT` | Read-only account for lookups; never signs | no |
| `NEAR_AGREEMENTS_CONTRACT` | Shared agreement registry (`contracts/agreements`). Members call `record_acceptance` to publish their own signature; empty disables that path | no |
| `NEAR_DAO_FACTORY_ACCOUNT` | Sputnik factory the board mints through; defaults to `sputnikv2.testnet` on testnet and `sputnik-dao.near` on mainnet | no |
| `NEAR_DAO_CREATION_DEPOSIT_YOCTO` | Storage deposit attached to the factory `create`; 6 NEAR (`6000000000000000000000000`) by default, and the factory refunds whatever the DAO code does not use | no |
| `NEAR_INTENTS_BASE_URL` | Reserved for the 1Click quote route; empty disables it | no |
| `NEAR_LOGIN_WEB_RETURN_URL` | Page the wallet returns the NEP-413 fragment to; defaults to `${WEB_ORIGIN}/near/login` | no |
| `NEAR_LOGIN_NATIVE_RETURN_URL` | Deep link the native wallet flow returns to; defaults to `globiekeeper://auth/near` | no |
| `EXPO_PUBLIC_NEAR_WALLET_URL` | Meteor Wallet web app URL; Nightly and Sender are browser extensions with fixed URLs | no |
| `GLOBIE_FUND_TREASURY_ACCOUNT` | The sanctuary's own NEAR account. Gifts are a plain transfer to it — no checkout, no processor. Empty answers `409 fund_not_configured` and hides the pay button | yes |
| `GLOBIE_FUND_QUOTE_TTL_MS` | How long a frozen gift quote stays settleable; a slower donor asks for a fresh quote | no |
| `MCP_GLOBIE_EARTH_URL` | `https://mcp.globie.earth` — issues the Living Deed after the transfer is proven | no |
| `MCP_SESSION_DEVICE_ID` | Device id header the MCP accepts; empty skips the deed sync (the NEAR deed still stands) | no |
| `MCP_TIMEOUT_MS` | Give-up time for one MCP call; the sync is best-effort, never a settlement gate | no |
| `DATABASE_URL` | Defaults to the compose database on port 55432 | yes |
| `AGENT_CONFIRMATION_SECRET` | Signs agent confirmation tokens; required in production | prod |
| `NEAR_AI_API_KEY` | NEAR AI Cloud key for receipt parsing and Globie's replies; unset falls back to manual entry and the tools' own wording | no |
| `NEAR_AI_BASE_URL`, `VISION_MODEL`, `AGENT_MODEL` | Endpoint and models on NEAR AI Cloud; defaults are the hosted base plus `Qwen/Qwen3-VL-30B-A3B-Instruct` (vision) and `google/gemini-2.5-flash-lite` (chat, non-reasoning so a short reply is not truncated) | no |

**Verify without a browser:**

```bash
npm run api:verify:near
```

With `NEAR_USDC_CONTRACT` filled this prints the RPC endpoint, the token's `name`/`symbol`/`decimals`,
compares the decimals with `NEAR_USDC_DECIMALS`, and exits `0` on `OK`. On a clean `.env` it must fail
loudly — this is the guard, not a broken build:

```
Globie Keeper — NEAR rail check

network            testnet
rpc                https://test.rpc.fastnear.com
token contract     —
token decimals     6
explorer           https://testnet.nearblocks.io

FAIL  NEAR is not configured. Set NEAR_USDC_CONTRACT in .env and retry.
```

Exit code `1`. A decimals mismatch fails for the same reason: every amount would be off by `10^n`.

To verify one real transfer, without the database or the app:

```bash
npm run api:verify:near -- <TX_HASH> <SENDER.near>
```

It prints `found / succeeded / sender / token / receiver / amount / memo / explorer`, and fails if
the transaction is missing, failed, or called a different token contract.

The registry contract is checked the same way, without a network:

```bash
cd contracts/agreements && cargo test
```

Expected: `5 passed; 0 failed` — self-only recording, replace-in-place, third-party rejection,
malformed digests and unknown ids.

Other checks: `npm run typecheck` (client), `npm --prefix server run typecheck`, `curl
http://localhost:3001/api/health`.

### Walk the Donate flow

The hosted demo is <https://near-keeper.globie.ai/fund>; locally it is `/fund` once `npm start`
serves the web build. Sign in, and link a testnet account in **Settings → NEAR** first — a gift is
signed by the donor, so there is nothing the server can do without that account.

1. Open **Donate**. You should see two trees — `Yang Na` (urgent) and `Kae Na` (critical) — plus the
   treasury the money goes to. `GET /api/fund/projects` returns
   `{"treasuryAccount":"oldhat96.testnet","assets":["usdc","near"],"network":"testnet"}`; an empty
   `GLOBIE_FUND_TREASURY_ACCOUNT` answers `409 fund_not_configured` and the screen shows
   *Gifts are not open yet* instead of the pay panel.
2. Pick 1 tree, a `$5 / $10 / $25 / $50` chip, and **NEAR** or **USDC**. The app freezes a quote:
   `POST /api/fund/quote` answers
   `{"chainAmount":"1331628848405000000000000","decimals":24,"amountDisplay":"1.331628848405",`
   `"quoteRate":0.266325769681,"expiresAt":"…"}`. That integer is exactly what the wallet signs, and
   it stays valid for `GLOBIE_FUND_QUOTE_TTL_MS` (15 minutes by default), so the price cannot move
   while the wallet is open. After expiry the same quote answers `409 fund_quote_expired`.
3. Press **Donate**. Your wallet signs a plain `Transfer` (native NEAR) or an `ft_transfer` (USDC)
   to the treasury — the app never asks for a key and the server never sees a signature.
4. The deed appears in the history with a NEARBlocks link. `GET /api/fund/deeds` returns
   `{"deeds":[{"deedRef":"GLB-2026-000NNN","txHash":"…","amountDisplay":"1.331628848405",`
   `"explorerUrl":"…"}],"totalMinor":500,"totalTrees":1}`; the hash is the proof, and it is also the
   `reference` sent to `mcp.globie.earth/adopt_species`, so one transfer cannot mint two Living
   Deeds. Settling the same quote twice answers `200` with `"alreadySettled":true` instead of writing
   a second deed.
5. A transfer that is missing, failed, sent by another account, sent to another receiver, or for the
   wrong amount is refused before any deed row is written — the chain is the only source of truth.

Two things to know when reproducing this yourself:

- **The USDC path needs testnet USDC.** `oldhat96.testnet` is registered with the token
  (`storage_balance_of` is non-zero) but holds `0`, so native NEAR is the asset that demos out of the
  box. Any testnet account you fund behaves the same; the USDC quote is just `"5000000"` for `$5` at
  6 decimals.
- **The NEAR price comes from two upstreams.** Fiat rates come from `open.er-api.com`, which
  publishes no crypto pairs, so the `USD` snapshot is completed with
  `api.coinbase.com/v2/prices/NEAR-USD/spot`. If neither answers, the quote returns
  `503 fx_unavailable` rather than pricing a gift from a guess.

## Architecture

```
Expo client ──> Fastify API ──> PostgreSQL 16 + TimescaleDB
                    │
                    ├──> NEP-141 verifier ──> NEAR RPC (read-only)
                    ├──> unsigned-tx builder ──> NEP-141 transfer / registry call
                    │                            (the member's wallet signs)
                    ├──> agreement registry contract ──> one receipt per member
                    └──> pg-boss (reminders, outbox)
```

- [server/src/lib/near.ts](server/src/lib/near.ts) — the only definition of "this transfer counts as
  paid": amount conversion between ISO minor units and token decimals, plus the RPC `tx` check.
- [server/src/lib/near-settlement.ts](server/src/lib/near-settlement.ts) — request and settle, reusing
  the advisory-locked `settleShare()` so idempotency and Globie awards have exactly one
  implementation.
- [server/src/routes/near.ts](server/src/routes/near.ts) — `GET /api/near/status`,
  `PATCH /api/near/account`, `POST /api/shares/:id/request-transfer`, `POST /api/shares/:id/pay-link`,
  `POST /api/shares/:id/settle`, and the unsigned-transaction builders `POST /api/near/anchor-call`
  and `POST /api/near/record-acceptance`.
- [server/src/routes/agreements.ts](server/src/routes/agreements.ts) — agreement creation and
  consent, `POST /api/agreements/:id/anchor`, and the `POST /api/agreements/:id/split-vote` tally.
- [server/src/lib/sputnik.ts](server/src/lib/sputnik.ts) — the Sputnik DAO V2 adapter: reads
  `get_policy`, turns a role's threshold into "2 of 3 council", and encodes `add_proposal`,
  `act_proposal` and the factory `create` whose 6 NEAR deposit the wallet pays. The envelope is
  borsh, the arguments are JSON — a borsh body is rejected by the contract.
- [server/src/routes/social.ts](server/src/routes/social.ts) — treasury registration, the
  create/confirm pair above, bounties, payouts and policy sync.
- [contracts/agreements/src/lib.rs](contracts/agreements/src/lib.rs) — the registry contract behind
  the anchored path: `record_acceptance` (self-only, replace-in-place, NEP-297 event) plus read-only
  `get_acceptances` / `acceptance_count`. Five unit tests, deployed at `globie-reg.testnet`.
- [server/src/lib/split-vote.ts](server/src/lib/split-vote.ts) — the vote tally and the resolution
  order *bill vote → agreement vote → `agreements.split_mode`*, majority with a fronter tie-break.
- [server/src/routes/pay.ts](server/src/routes/pay.ts) and
  [server/src/lib/pay-links.ts](server/src/lib/pay-links.ts) — the public `GET /api/pay/:token` read
  and the one-live-token-per-share mint. The token is the only secret stored in the clear, because a
  forwardable link is the whole point and it grants exactly one share's read.
- [server/src/lib/settlement.ts](server/src/lib/settlement.ts) — provider-agnostic settlement: one row
  in `payments` keyed by `(provider, provider_ref)`, so a tx hash is a replay-safe reference.
- [db/migrations/012_near_rails.sql](db/migrations/012_near_rails.sql) — accounts, per-member
  overrides, treasury, and `settlement_tx_hash` / `intent_quote_id` on `shares` and `tips`.
- [server/src/near-verify.ts](server/src/near-verify.ts) — the browser-free verifier above.
- [app/](app/) and [lib/](lib/) — the Expo client (groups, bill, confirmation, NEAR rail).

## Team

| Name | Role | Contact |
|---|---|---|
| `<LEAD_NAME — FILL>` | product + server | `<EMAIL — FILL>` |
| `<NAME — FILL>` | client | `<HANDLE — FILL>` |

Payout address (NEAR mainnet): [`globieearth.near`](https://nearblocks.io/address/globieearth.near)

## Security

- No keys, JWTs or `.env` files are committed; [.env.example](.env.example) lists names only.
- The server holds **no signing key**. It verifies transfers with read-only RPC calls; the payer signs
  in their own wallet, so a compromised API can misfile a payment but cannot move funds. Minting a DAO
  is the same shape: the server builds the factory `create`, and the wallet signs and pays the deposit
  itself.
- Settlement is idempotent on `(provider, provider_ref)` and guarded by
  `pg_advisory_xact_lock(hashtext(agreement_id))`, so a replayed tx hash cannot pay a share twice.
- Contract: the token is the one named in `NEAR_USDC_CONTRACT`; the only contract we wrote is the agreement registry in `contracts/agreements` (`globie-reg.testnet`), which holds no funds and has no access keys. Both are unaudited — this is a hackathon build.
- Demo wallet holds at most `<AMOUNT — FILL>`, on testnet unless the video says otherwise.

## Licence

MIT for the source code. The Globie names, logo, mascot artwork and domains are
not included in that grant — see [LICENSE](LICENSE).
