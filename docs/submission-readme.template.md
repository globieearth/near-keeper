# <PROJECT_NAME>

> <ONE_SENTENCE: what it does, for whom, and the one moment that proves it works.>

**Demo:** <https://your-demo-url> · **Video:** <https://x.com/...> · **Tracks:** `<track-id>`, `<track-id>`

<!-- Keep this file honest and reproducible. AI screeners run it before human judges do. -->

---

## What it does

<3–6 sentences. Name the user, the pain, the action they take, and the result. No adjectives that
cannot be shown in the demo.>

**The 60-second path a judge should take:**

1. Open <DEMO_URL>.
2. Connect <WALLET / LOGIN PATH> — no seed phrase, no testnet faucet.
3. Do <THE_ONE_ACTION>, wait for <EXPECTED_RESULT>.
4. Observe <ON-CHAIN EFFECT> at <EXPLORER_LINK>.

If the demo is not public, record exactly this path and link the video above.

## How NEAR is used

| Item | Value |
|---|---|
| Network | `mainnet` <!-- or testnet, but state it --> |
| Contract | `<account.near>` |
| Explorer | <https://nearblocks.io/address/account.near> |
| Primitives | <!-- NEAR Intents / Chain Signatures (1Click) / NEP-141 / NEP-171 / NEP-245 / Function Call Keys / sub-accounts / Sputnik DAO / Trezu / NEAR AI Cloud / TEE --> |
| Why NEAR | <The specific capability that made another chain a worse fit. One paragraph.> |

<If you used NEAR Intents or Chain Signatures, link the exact transaction or quote here.
If 1Click is used without a partner JWT, say so — the 0.2% fee applies and there is no testnet.>

## Reproduce it

```bash
git clone <REPO_URL> && cd <REPO_DIR>
<INSTALL_COMMAND>
cp .env.example .env        # fill the values listed below
<RUN_COMMAND>
```

| Variable | Purpose | Required |
|---|---|---|
| `<VAR_NAME>` | <what it is> | yes |
| `<VAR_NAME>` | <what it is> | no |

**Verify without a browser:**

```bash
<TEST_COMMAND>
```

Expected: `<EXACT OUTPUT OR ASSERTION>`.

> Reproducibility is scored. A judge must reach a result with the commands above, from a clean clone,
> without asking you a question.

## Architecture

```
<component> ──> <component> ──> <chain / API>
      │
      └── <storage / queue / model>
```

- `<path/>` — <responsibility>
- `<path/>` — <responsibility>

## Hackathon disclosure

Required by the rules; undisclosed baseline is the quiet disqualifier.

| Question | Answer |
|---|---|
| Built entirely inside 1–14 Nov 2026? | <yes / no — explain> |
| Code before 19 Oct 2026 | <none / what existed, with commit range> |
| Baseline tag | `pre-hackathon` at `<commit>` |
| Submission tag | `hackathon-submission` at `<commit>` |
| Reused libraries / templates | <names + licences> |
| AI-generated code | <which parts, which tool> |
| Prior deployment on another chain | <none / product name + what is new here> |

## Team

| Name | Role | Contact |
|---|---|---|
| <LEAD_NAME> | <role> | <email> |
| <NAME> | <role> | <handle> |

Payout address (NEAR mainnet): `<account.near>`

<!-- If this is a second submission from the same email, name the other project here and add the
same line to that project's README. The limit is 2 per person. -->

## Security

- No keys, JWTs or `.env` files are committed; `.env.example` lists names only.
- Contracts: <audited? by whom? otherwise state "unaudited, hackathon build">.
- Demo wallet holds at most <AMOUNT>; all signing keys are scoped to <SCOPE>.

## Licence

<MIT / Apache-2.0 / other> — see `LICENSE`.

---

<details>
<summary>Submission checklist (do not ship this section publicly)</summary>

- [ ] Repo is public and the URL has never been submitted before
- [ ] `hackathon-submission` tag pushed; `pre-hackathon` baseline tag exists
- [ ] Hosted demo reachable in a private window, no login wall
- [ ] X post is public, tags `@NEARProtocol` and `#NEARHackathon`
- [ ] Video or screenshots attached to the post
- [ ] Every track listed here is one the project genuinely fits
- [ ] README states the exact reproduce commands and expected output
- [ ] Disclosure table filled in
- [ ] Payload dry-run against the field rules; single UUID generated
- [ ] Human has read the payload and set `consent: true`
- [ ] Submitted before 13 Nov, not on the 14th
</details>
