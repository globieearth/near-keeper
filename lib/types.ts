export type Currency = string;

export type Group = {
  id: string;
  name: string;
  defaultCurrency: Currency;
  ownerId: string;
  inviteToken: string;
  createdAt: string;
  /** What kind of shared cost this is — see DEV_PLAN §2.21. */
  kind: string;
};

export type Member = {
  id: string;
  groupId: string;
  userId: string;
  displayName: string;
  role: 'owner' | 'fronter' | 'member';
  status: 'invited' | 'active' | 'removed';
};

export type Agreement = {
  id: string;
  groupId: string;
  currency: Currency;
  estimatedTotalMinor: number;
  deadline: string | null;
  status: 'draft' | 'pending' | 'accepted' | 'cancelled' | 'settled';
  createdBy: string;
  frontedBy: string | null;
  acceptedCount: number;
  memberCount: number;
  /** What the money is for — see DEV_PLAN §2.21. */
  kind?: string;
  splitMode?: 'itemised' | 'equal' | 'weighted' | 'quantity' | 'exact';
  recurrence?: string;
  /** sha256 of the canonical terms snapshot; what a signature covers. */
  termsHash?: string | null;
  /** `signed` = NEP-413 signature only; `anchored` = signature + public record. */
  consentLevel?: 'signed' | 'anchored';
  /** The late-fee rule the members signed for. */
  interestMode?: InterestMode;
  /** Percent per month, in basis points (200 = 2%). */
  interestRateBps?: number | null;
  /** Ceiling on the whole charge, as basis points of the share. */
  interestCapBps?: number | null;
};

/** The only two options the group votes between. */
export type SplitVote = 'itemised' | 'equal';

/**
 * How the group currently wants a bill divided, and how that was decided.
 * `source: 'default'` means nobody voted, so the mode the creator signed wins.
 */
export type SplitVoteSummary = {
  tally: Record<SplitVote, number>;
  totalVotes: number;
  memberCount: number;
  /** This member's own vote, if they cast one at this level. */
  myVote: SplitVote | null;
  /** The mode that would be used if the bill were locked now. */
  resolvedMode: SplitVote;
  /** Bill votes override agreement votes, which override the signed default. */
  source: 'bill' | 'agreement' | 'default';
  /** A tie only happens once at least one vote exists; the fronter breaks it. */
  tie: boolean;
};

/** `GET /agreements/:id/consent` — everything the wallet is about to sign. */
export type AgreementConsent = {
  terms: Record<string, unknown>;
  termsHash: string;
  consentLevel: 'signed' | 'anchored';
  /** The exact NEP-413 message body. */
  message: string;
  /** Base64 of the 32 raw bytes; single-use. */
  nonce: string;
  recipient: string;
};

/** What a wallet returns for a NEP-413 `sign_message` action. */
export type SignedConsent = {
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** Base64 of the 64-byte detached signature. */
  signature: string;
};

/**
 * One member's acceptance. The signature is off-chain; `anchorTxHash` is set
 * once the fronter publishes it, and only then can an explorer show it.
 */
export type AgreementAcceptance = {
  memberId: string;
  displayName: string;
  /** The account that signed; null for a tap-only acceptance. */
  nearAccount: string | null;
  publicKey: string | null;
  /** Base64 NEP-413 signature over `termsHash`. */
  signature: string | null;
  termsHash: string | null;
  signedAt: string | null;
  acceptedAt: string;
  /** The `ft_transfer` memo that published this signature, once anchored. */
  anchorTxHash: string | null;
};

/** `GET /agreements/:id/acceptances`. */
export type AgreementAcceptances = {
  termsHash: string | null;
  consentLevel: 'signed' | 'anchored';
  acceptances: AgreementAcceptance[];
};

/** `POST /agreements/:id/anchor` — the verified anchor transaction. */
export type AgreementAnchor = {
  txHash: string;
  explorerUrl: string;
  /** The terms digest the anchor call carried as `args.account_id`. */
  digest: string;
  anchoredCount: number;
};

export type BillItem = {
  id: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  confidence: number;
  /** Free-form category the line was read as (food, fare, household…). */
  kind: string | null;
  /** `kg`, `tray`, `hour` — the unit a group buy counts in. */
  unit: string | null;
};

export type BillSource = 'receipt_vision' | 'manual' | 'invoice' | 'quantity_claim';

export type Bill = {
  id: string;
  agreementId: string;
  merchant: string | null;
  currency: Currency;
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  tipMinor: number;
  discountMinor: number;
  totalMinor: number;
  status: string;
  items: BillItem[];
  framesExtracted: number;
  warnings: string[];
  kind?: string;
  source?: BillSource;
  title?: string | null;
};

export type Allocation = {
  id: string;
  billItemId: string;
  memberId: string;
  memberName: string;
  itemName: string;
  qty: number;
  amountMinor: number;
  status: 'proposed' | 'confirmed' | 'disputed';
};

export type Share = {
  id: string;
  billId: string;
  groupId: string;
  groupName?: string;
  memberId: string;
  memberName: string;
  amountMinor: number;
  currency: Currency;
  status:
    | 'proposed'
    | 'confirmed'
    | 'requested'
    | 'paid'
    | 'settled'
    | 'disputed'
    | 'failed'
    | 'refunded';
  dueAt: string | null;
  paidAt: string | null;
  /** NEP-141 transfer hash once this share settled on the NEAR rail. */
  settlementTxHash?: string | null;
  /** Fronter's NEAR account: the recipient when this share is paid on NEAR. */
  payTo?: string | null;
  /** Amount in the token's own decimals, as a decimal string. */
  chainAmount?: string | null;
  /** USD per one unit of `currency`, locked when this share was quoted. */
  quoteRate?: number | null;
  /** When that rate was published. */
  quoteAsOf?: string | null;
  /** Memo the wallet should attach, so the receipt names this share. */
  memo?: string | null;
  /** NEP-141 contract the transfer is denominated in. */
  tokenContract?: string | null;
};

/**
 * A member's confirmed lines on a bill that has not been locked yet.
 * Shares only exist after the fronter finalizes, so this is what `/me/shares`
 * shows in between — the money is real, it just is not collectable yet.
 */
export type PendingShare = {
  billId: string;
  groupId: string;
  groupName: string;
  merchant: string | null;
  amountMinor: number;
  currency: Currency;
  billStatus: string;
  /** Whoever fronted the expense, by display name. */
  frontedBy: string | null;
  /** True when this member is the fronter and can lock the split themselves. */
  isFronter: boolean;
};

/**
 * A voluntary extra for the person who fronted the bill (DEV_PLAN §2.18).
 * Deliberately not a `Share`: a tip never settles anything, and it is paid to
 * the fronter directly, so it needs its own row.
 */
export type Tip = {
  id: string;
  billId: string;
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string;
  toMemberName: string;
  amountMinor: number;
  currency: Currency;
  message: string | null;
  status: 'proposed' | 'requested' | 'paid' | 'refunded' | 'failed';
  paidAt: string | null;
  createdAt: string;
  /** NEP-141 transfer hash once this tip settled on the NEAR rail. */
  settlementTxHash?: string | null;
  /** Fronter's NEAR account: where the tip transfer must land. */
  payTo?: string | null;
  /** Pending only: the tip is one wallet transfer from being settled. */
  canFinish?: boolean;
  /** NEP-141 contract the tip is denominated in; only on the caller's own tip. */
  tokenContract?: string | null;
  /** Tip amount in the token's own decimals, as a decimal string. */
  chainAmount?: string | null;
  /** USD per one unit of `currency`, locked when this tip was quoted. */
  quoteRate?: number | null;
  /** When that rate was published. */
  quoteAsOf?: string | null;
  /** Memo the wallet should attach, so the receipt names this tip. */
  memo?: string | null;
};

export type TipsResponse = {
  billId: string;
  currency: Currency;
  frontedBy: string | null;
  frontedByName: string;
  canTip: boolean;
  /** Sum of tips that actually went through. */
  totalMinor: number;
  myTip: Tip | null;
  tips: Tip[];
};

/**
 * The late-fee rule agreed when the agreement was created. `none` is a stored
 * choice, not an absent one — it is inside the signed terms.
 */
export type InterestMode = 'none' | 'monthly';

/**
 * A late fee on one overdue share. Like a tip it is its own money row: it
 * never replaces the share and never settles the bill.
 */
export type InterestCharge = {
  id: string;
  shareId: string;
  billId: string;
  agreementId: string;
  /** The member who owes it. */
  memberId: string;
  memberName: string;
  /** The fronter who receives it. */
  toMemberId: string;
  toMemberName: string;
  amountMinor: number;
  currency: Currency;
  rateBps: number;
  /** Ceiling on the whole charge, as basis points of the share. */
  capBps: number | null;
  daysLate: number;
  status: 'requested' | 'paid' | 'waived' | 'failed';
  raisedAt: string;
  paidAt: string | null;
  createdAt: string;
  settlementTxHash: string | null;
  /** Fronter's NEAR account: where the transfer must land. */
  payTo: string | null;
  /** Fee amount in the token's own decimals, frozen when it was raised. */
  chainAmount: string | null;
  quoteRate: number | null;
  quoteAsOf: string | null;
  memo: string;
  /** The debtor may pay it now. */
  canPay?: boolean;
  tokenContract?: string | null;
};

export type InterestResponse = {
  billId: string;
  currency: Currency;
  frontedBy: string | null;
  frontedByName: string;
  mode: InterestMode;
  rateBps: number | null;
  capBps: number | null;
  /** True for the fronter, once the bill is finalized. */
  canRaise: boolean;
  /** Sum of fees that actually went through. */
  totalMinor: number;
  charges: InterestCharge[];
};

/** `POST /interest/:id/settle` — a verified fee transfer and its receipt. */
export type InterestSettleResult = {
  chargeId: string;
  status: 'paid';
  alreadyPaid: boolean;
  explorerUrl: string;
};

export type LeaderboardRow = {
  memberId: string;
  memberName: string;
  frontedMinor: number;
  globieBalance: number;
  repaymentSpeedHours: number | null;
  isHero: boolean;
};

export type TimelineEvent = {
  id: string;
  at: string;
  actor: string;
  type: string;
  summary: string;
  amountMinor?: number;
  /** Set when the event settled on chain, so the feed can link the transfer. */
  txHash?: string;
  /** Only present on the cross-group feed (`GET /me/activity`). */
  groupId?: string;
  groupName?: string;
  currency?: Currency;
};

/**
 * `GET /near/status`. `configured` is false until the server has a NEP-141
 * token contract, and then no transfer can be quoted.
 */
export type NearStatus = {
  configured: boolean;
  network: 'testnet' | 'mainnet';
  tokenContract: string | null;
  /**
   * The shared agreement registry (dev plan §2.21). When set, members can
   * record their own acceptance on chain instead of the fronter publishing a
   * single digest for the whole group.
   */
  agreementsContract: string | null;
  explorerUrl: string;
  /** The member's linked account, if any. */
  account: string | null;
  verified: boolean;
};

/**
 * `POST /shares/:id/request-transfer`. Everything the payer needs to build the
 * NEP-141 call in their own wallet — nothing is signed on the server.
 */
export type TransferRequest = {
  shareId: string;
  status: string;
  amount: number;
  currency: Currency;
  /** Fronter's account id: the recipient of the transfer. */
  payTo: string;
  tokenContract: string;
  /** `amount` in the token's own decimals, as a decimal string. */
  chainAmount: string;
  /** USD per one unit of `currency`, locked when this share was quoted. */
  quoteRate: number;
  /** When that rate was published. */
  quoteAsOf: string;
  memo: string;
  alreadyRequested: boolean;
};

/** `POST /shares/:id/pay-link` — a forwardable link to one share's instructions. */
export type SharePayLink = {
  token: string;
  /** App-relative URL (`/pay/<token>`); the client prepends its own origin. */
  path: string;
  /** The frozen transfer behind the link, identical to a request-transfer. */
  transfer: TransferRequest;
};

/**
 * `GET /pay/:token` — the signed-out view of one share. It is deliberately
 * narrow: no payer, no balance, no other bill.
 */
export type PayLinkView = {
  /** Lets the page settle the share once the visitor has signed in. */
  shareId: string;
  billTitle: string;
  currency: Currency;
  amountMinor: number;
  /** `amountMinor` in the bill's currency, already formatted. */
  amount: string;
  /** USDC to sign, or null when the share was never quoted. */
  chainAmount: string | null;
  payeeAccount: string | null;
  tokenContract: string | null;
  memo: string;
  status: 'due' | 'paid';
  explorerUrl: string | null;
};

/** `POST /shares/:id/settle` — a verified on-chain transfer plus its receipt. */
export type NearSettleResult = {
  shareId: string;
  alreadyPaid: boolean;
  pointsAwarded: number;
  rank: number | null;
  billSettled: boolean;
  explorerUrl: string;
  amount: number;
  currency: Currency;
  payTo: string | null;
};

/**
 * `POST /bills/:id/tips`. The answer is the transfer the member must sign —
 * recipient, token amount and memo — never a checkout link.
 */
export type TipTransferRequest = {
  tipId: string;
  status: string;
  amount: number;
  currency: Currency;
  /** Fronter's account id: the recipient of the transfer. */
  payTo: string;
  tokenContract: string;
  /** `amount` in the token's own decimals, as a decimal string. */
  chainAmount: string;
  /** USD per one unit of `currency`, locked when this tip was quoted. */
  quoteRate: number;
  /** When that rate was published. */
  quoteAsOf: string;
  memo: string;
  alreadyRequested: boolean;
};

/**
 * `POST /near/ft-transfer`. An unsigned `ft_transfer` the member's wallet signs
 * in one tap: borsh-encoded and base64'd, which is exactly what Meteor's
 * `sign` action takes. The API still verifies the resulting hash, so this
 * instruction cannot move anything on its own.
 */
export type PreparedFtTransfer = {
  /** Base64 of the borsh-encoded `Transaction`. */
  transaction: string;
  /** The member's linked account: the wallet signs as this. */
  signerId: string;
  receiverId: string;
  /** Token amount as a decimal string, e.g. `"1.49"`. */
  amount: string;
  memo: string | null;
  /** Recent block hash the transaction was built against. */
  blockHash: string;
};

/**
 * `POST /near/anchor-call`. An unsigned read-only `ft_balance_of` call whose
 * argument is the terms digest. Nothing moves and no storage is written — the
 * transaction exists only to put the digest on public record.
 */
export type PreparedAnchorCall = {
  /** Base64 of the borsh-encoded `Transaction`. */
  transaction: string;
  /** The member's linked account: the wallet signs as this. */
  signerId: string;
  /** The terms digest, carried as `args.account_id`. */
  digest: string;
  /** The contract method that will be called (`ft_balance_of`). */
  method: string;
  /** Recent block hash the transaction was built against. */
  blockHash: string;
};

/**
 * `POST /near/record-acceptance`. An unsigned `record_acceptance` call on the
 * shared registry. Unlike the read-only anchor this writes a row, so it costs
 * storage — but the contract proves the signer is the member themselves.
 */
export type PreparedRecordAcceptance = {
  /** Base64 of the borsh-encoded `Transaction`. */
  transaction: string;
  /** The member's verified account: the wallet signs as this. */
  signerId: string;
  /** The terms digest the record is filed under. */
  digest: string;
  /** The agreement id the record is filed under. */
  agreementId: string;
  /** The contract method that will be called (`record_acceptance`). */
  method: string;
  /** The registry contract that will be called. */
  registry: string;
  /** Recent block hash the transaction was built against. */
  blockHash: string;
};

/**
 * `POST /near/native-transfer`. The same unsigned hand-off as
 * `PreparedFtTransfer`, but for native NEAR: no contract, no memo, and the
 * deposit is the exact yoctoNEAR integer the gift quote froze.
 */
export type PreparedNativeTransfer = {
  /** Base64 of the borsh-encoded `Transaction`. */
  transaction: string;
  /** The member's linked account: the wallet signs as this. */
  signerId: string;
  receiverId: string;
  /** yoctoNEAR as an integer string. */
  deposit: string;
  /** The same number for a human, e.g. `"0.42"`. */
  amount: string;
  /** Recent block hash the transaction was built against. */
  blockHash: string;
};

/**
 * Globie Fund. A gift is a plain transfer to the sanctuary, so the catalogue
 * carries everything the donate screen needs to open a wallet — and nothing
 * about a processor, because there is none.
 */
export type FundAsset = 'usdc' | 'near';

export type FundProject = {
  id: string;
  name: string;
  latinName: string;
  thaiName: string | null;
  story: string;
  needLevel: 'urgent' | 'critical' | 'steady';
  needNote: string;
  unitPriceMinor: number;
  currency: string;
};

/** `GET /fund/projects`. */
export type FundCatalogue = {
  projects: FundProject[];
  /** `usdc` is absent when the server has no NEP-141 token configured. */
  assets: FundAsset[];
  network: 'testnet' | 'mainnet';
  explorerUrl: string;
  /** Null when the sanctuary has not linked a receiving account yet. */
  treasuryAccount: string | null;
};

/** `POST /fund/quote` — a frozen price for one gift. */
export type FundQuote = {
  quoteId: string;
  projectId: string;
  projectName: string;
  asset: FundAsset;
  qty: number;
  amountMinor: number;
  currency: string;
  /** The exact integer the wallet signs, in the asset's own base units. */
  chainAmount: string;
  /** The same number for a human: `"5.00"` USDC or `"1.63"` NEAR. */
  amountDisplay: string;
  /** USDC contract for `usdc`; null for native NEAR, which calls no contract. */
  tokenContract: string | null;
  decimals: number;
  treasuryAccount: string;
  quoteRate: number;
  quoteAsOf: string;
  expiresAt: string;
};

export type FundDeed = {
  id: string;
  /** The sanctuary's own deed number (`GLB-YYYY-NNNNNN`). */
  deedRef: string;
  projectId: string;
  projectName: string;
  qty: number;
  amountMinor: number;
  currency: string;
  asset: FundAsset;
  chainAmount: string;
  amountDisplay: string;
  payerAccount: string;
  treasuryAccount: string;
  txHash: string;
  explorerUrl: string;
  /** The Living Deed number from mcp.globie.earth, once it answered. */
  mcpDeedRef: string | null;
  createdAt: string;
};

/** `POST /fund/settle`. */
export type FundSettleResult = {
  deed: FundDeed;
  alreadySettled: boolean;
  mcpDeedRef: string | null;
  explorerUrl: string;
};

/** `GET /fund/deeds` — the donor's own giving history. */
export type FundGiving = {
  deeds: FundDeed[];
  totalMinor: number;
  totalTrees: number;
};

/** `POST /tips/:id/settle` — a verified tip transfer and its receipt. */
export type TipSettleResult = {
  tipId: string;
  status: 'paid';
  alreadyPaid: boolean;
  pointsAwarded: number;
  explorerUrl: string;
};

/** The agent tools of the contract (DEV_PLAN §2.11, §2.23). */
export type AgentToolName =
  | 'parse_receipt_media'
  | 'propose_allocation'
  | 'request_item_confirmation'
  | 'create_payment_request'
  | 'get_bill_status'
  | 'send_reminder'
  | 'award_points'
  | 'explain_feature';

export type ReminderTone = 'friendly' | 'firm' | 'final';

/** One prior bubble, sent back so a follow-up has something to point at. */
export type AgentTurn = { from: 'you' | 'globie'; text: string };

/**
 * `POST /api/agent/message`. When `confirmationRequired` is true nothing has
 * happened yet: repeat the same call with `confirmToken` to commit it.
 */
export type AgentResponse = {
  tool: AgentToolName;
  /** `null` for a tool that does not act inside a group (e.g. help). */
  groupId: string | null;
  executed: boolean;
  confirmationRequired: boolean;
  confirmToken: string | null;
  result: Record<string, unknown>;
  reply: string;
};

/**
 * `POST /api/agent/chat` — free conversation with no tool behind it
 * (DEV_PLAN §2.22). It explains the current state and never changes it.
 */
export type AgentChatResponse = { reply: string; groupId: string | null };

/**
 * One page of the user manual (DEV_PLAN §2.23). `GET /api/help` serves the
 * same strings Globie's `explain_feature` tool returns.
 */
export type HelpAudience = 'everyone' | 'members' | 'fronters';

export type HelpTopic = {
  id: string;
  title: string;
  summary: string;
  audience: HelpAudience;
  steps: string[];
  /** A route in this app, or null for a concept with no single screen. */
  screen: string | null;
  related: string[];
};

/**
 * Social Money (DEV_PLAN §12): a group's own Sputnik DAO, its bounty board,
 * and the trust record that decides how much of a payout the DAO lets one
 * person approve. Nothing here is signed by the server — a payout leaves as an
 * unsigned `add_proposal` transaction for the member's wallet.
 */

/** Which approval path the payout policy chose, cheapest first. */
export type PayoutTier = 'auto' | 'council_one' | 'dao';

/** A role as the DAO's `get_policy()` describes it. */
export type TreasuryRole = {
  name: string;
  exists: boolean;
  memberCount: number;
  requiredApprovals: number;
};

/** The three defaults the group may override when it registers a treasury. */
export type TreasuryCaps = {
  autoApproveCapMinor: number;
  midApproveCapMinor: number;
  periodCapMinor: number;
};

/** `GET /groups/:groupId/treasuries`. */
export type SocialTreasury = {
  id: string;
  groupId: string;
  label: string;
  network: string;
  daoAccount: string;
  /** Always `sputnik`; `trezu` only appears on rows written before the adapter unified. */
  source: string;
  autoRole: string;
  councilRole: string;
  caps: TreasuryCaps;
  periodDays: number;
  /** `get_policy()` as the chain returned it; null until the first sync. */
  policy: Record<string, unknown> | null;
  policySyncedAt: string | null;
  /** The auto/council roles resolved against `policy`; null without one. */
  roles: { auto: TreasuryRole; council: TreasuryRole } | null;
  createdAt: string;
};

/**
 * `POST /groups/:groupId/treasuries/create` — the unsigned factory `create`
 * the member's wallet signs. Signing it costs `depositYocto` (6 NEAR) and
 * mints `daoAccount`.
 */
export type PreparedDaoCreation = {
  transaction: string;
  blockHash: string;
  daoAccount: string;
  name: string;
  factoryAccount: string;
  network: string;
  /** yoctoNEAR, as a string because it exceeds `Number.MAX_SAFE_INTEGER`. */
  depositYocto: string;
};

/** One bounty on the board. Presets arrive with `source: 'preset'`. */
export type SocialBounty = {
  id: string;
  groupId: string;
  treasuryId: string | null;
  treasuryLabel: string | null;
  daoAccount: string | null;
  title: string;
  description: string;
  category: string;
  source: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  amountDisplay: string;
  /** The exact amount the DAO will propose, in the asset's base units. */
  chainAmount: string;
  chainDisplay: string;
  chainSymbol: string;
  /** `open` | `claimed` | `submitted` | `approved` | `paid` | `cancelled`. */
  status: string;
  visibility: string;
  deadline: string | null;
  claimerMemberId: string | null;
  claimerName: string | null;
  claimedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** A member's claim on a bounty, from filing it to the council's answer. */
export type SocialClaim = {
  id: string;
  bountyId: string;
  memberId: string;
  memberName: string | null;
  note: string;
  evidenceUrl: string | null;
  status: string;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

/** One line of the bounty's own history. */
export type SocialBountyEvent = {
  id: string;
  eventType: string;
  summary: string;
  actorMemberId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/** A payout frozen at proposal time and settled by reading the chain. */
export type SocialPayout = {
  id: string;
  bountyId: string;
  claimId: string;
  treasuryId: string;
  recipientAccount: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  amountDisplay: string;
  chainAmount: string;
  chainDisplay: string;
  chainSymbol: string;
  tier: PayoutTier;
  policyRole: string;
  requiredApprovals: number;
  proposalId: string | null;
  proposalTxHash: string | null;
  /** `pending` | `proposed` | `executed` | `failed`. */
  status: string;
  failureReason: string | null;
  explorerUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `POST /bounties/:id/payout/preview` — the tier decision, before money moves. */
export type SocialPayoutPlan = {
  claimId: string;
  bountyId: string;
  bountyTitle: string;
  treasuryId: string;
  daoAccount: string;
  asset: 'near' | 'usdc';
  amountMinor: number;
  currency: string;
  chainAmount: string;
  recipientAccount: string;
  /** The account the proposal will be proposed by — the signed-in member. */
  signerAccount: string;
  tier: PayoutTier;
  policyRole: string;
  reason: string;
  role: TreasuryRole;
  trustScore: number;
  spentInPeriodMinor: number;
  periodCapMinor: number;
  headroomMinor: number;
  /** False when the DAO has no such role, so no proposal can be built. */
  canPrepare: boolean;
};

/**
 * `POST /bounties/:id/payout`. `transaction` is base64 borsh for the wallet;
 * `blockHash` pins the transaction to the block it was built against.
 */
export type PreparedBountyPayout = {
  payout: SocialPayout;
  plan: SocialPayoutPlan;
  transaction: string;
  blockHash: string;
};

/** `GET /bounties/:id`. */
export type SocialBountyDetail = {
  bounty: SocialBounty;
  claims: SocialClaim[];
  payouts: SocialPayout[];
  events: SocialBountyEvent[];
};

/** One row of the contributor trust table. */
export type SocialTrust = {
  memberId: string;
  completedCount: number;
  paidMinor: number;
  currency: string;
  /** 0–100; gates the auto and council-one tiers. */
  score: number;
  lastPaidAt: string | null;
};
