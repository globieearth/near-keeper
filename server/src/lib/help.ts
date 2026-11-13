/**
 * The user manual (DEV_PLAN §2.23).
 *
 * One typed catalogue, owned by the server so the Help screen and Globie read
 * the same words. Nothing here is generated: the assistant returns these
 * strings verbatim, which is what stops it inventing a procedure.
 */

export type HelpAudience = 'everyone' | 'members' | 'fronters';

export type HelpTopic = {
  id: string;
  title: string;
  summary: string;
  audience: HelpAudience;
  steps: string[];
  /** Where the reader can see this in the app (a route), or null for concepts. */
  screen: string | null;
  related: string[];
};

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'sign-in',
    title: 'Sign in with a NEAR wallet',
    summary:
      'There is no password and no email code. Your NEAR wallet signs a short message and Globie Keeper opens a session.',
    audience: 'everyone',
    steps: [
      'Tap Sign in and pick the wallet you already use.',
      'Approve the connection in the wallet.',
      'Approve the sign-message request. It proves you hold the account; it cannot move funds.',
      'You stay signed in on this device for about 60 days.',
    ],
    screen: '/near/login',
    related: ['wallets', 'network', 'settings'],
  },
  {
    id: 'wallets',
    title: 'Which wallets work',
    summary:
      'Three wallets are supported: Meteor, Nightly and Sender. On a phone only Meteor is listed, because the other two need a browser extension.',
    audience: 'everyone',
    steps: [
      'Meteor opens its own window — keep it open until it says it is done.',
      'Nightly and Sender appear inside the page; approve there.',
      'No other wallet is accepted, and MyNearWallet has shut down.',
      'If a wallet shows a network warning, switch it to the network Globie is on and try again.',
    ],
    screen: '/near/login',
    related: ['sign-in', 'network'],
  },
  {
    id: 'network',
    title: 'Testnet and mainnet',
    summary:
      'Globie runs on one NEAR network at a time, shown on the sign-in screen. A wallet set to the other network is refused before anything is signed.',
    audience: 'everyone',
    steps: [
      'Check the network label under the wallet list.',
      'Switch the wallet to that network.',
      'Sign in again — the refusal message names both networks when they differ.',
    ],
    screen: '/near/login',
    related: ['wallets', 'sign-in'],
  },
  {
    id: 'home',
    title: 'Home',
    summary:
      'Home is the short list of what needs you today: open groups, money waiting, and the next thing to do.',
    audience: 'members',
    steps: [
      'Open a group card to see its agreement and expense.',
      'Tap the receipt action when a group is waiting for its bill.',
      'Use the section headings to jump to groups, shares or activity.',
    ],
    screen: '/',
    related: ['groups', 'expenses', 'shares'],
  },
  {
    id: 'groups',
    title: 'Groups, invites and QR codes',
    summary:
      'A group is the people who share a cost. Its kind (meal, groceries, rent, trip and so on) decides whether it holds one expense or a running tab.',
    audience: 'members',
    steps: [
      'Create a group, or join one with the invite code a member sends you.',
      'Scan the invite QR from the scanner, or paste the code on the join screen.',
      'The owner and fronters can invite more people from the group screen.',
    ],
    screen: '/groups',
    related: ['group-detail', 'home'],
  },
  {
    id: 'group-detail',
    title: 'Inside a group',
    summary:
      'The group screen holds the current agreement, the member list, the expense, and — for running tabs — the next period.',
    audience: 'members',
    steps: [
      'Read the agreement terms before you tap to agree.',
      'Your tap is recorded as a wallet signature over the terms.',
      'Once the money is square, a running tab can open its next period.',
    ],
    screen: '/groups/[id]',
    related: ['expenses', 'leaderboard', 'groups', 'bounties'],
  },
  {
    id: 'expenses',
    title: 'An expense from receipt to settled',
    summary:
      'One bill moves through reading, claiming, splitting, confirming, locking and collecting. Each step is visible on the expense screen.',
    audience: 'members',
    steps: [
      'The fronter uploads the receipt; Globie reads the lines for everyone to check.',
      'Before locking, the fronter can fix a misread line — rename it, change the qty or price, delete it or add one — or rescan the receipt, which replaces every line.',
      'Members claim the lines they had.',
      'The fronter proposes the split, and each member confirms their share.',
      'The fronter locks the bill so nobody edits it, then requests payment.',
      'Shares settle on NEAR and the bill closes.',
    ],
    screen: '/groups/[id]/bill',
    related: ['paying', 'tips', 'group-detail'],
  },
  {
    id: 'paying',
    title: 'Paying your share on NEAR',
    summary:
      'Each share carries the amount, the fronter’s account and a memo. The transfer is what settles it — Globie never holds your money.',
    audience: 'members',
    steps: [
      'Open the share and check the amount and recipient.',
      'Send the transfer from your wallet, keeping the memo it shows.',
      'Globie matches the transfer and marks the share paid.',
    ],
    screen: '/me/shares',
    related: ['shares', 'expenses', 'network', 'pay-link'],
  },
  {
    id: 'pay-link',
    title: 'Pay a share without an account',
    summary:
      'A share can be forwarded as a link. Whoever opens it sees the amount, the payee and the memo — no install, no sign-in, and the page never charges anything.',
    audience: 'everyone',
    steps: [
      'On the bill, tap Share link beside a share. On the web the link is copied; on a phone it opens the share sheet.',
      'Open the link — it works signed out and shows the amount, the USDC amount to send, the payee and the memo.',
      'Tap Copy payment details, then send that exact amount from your own wallet with the memo attached.',
      'The memo is how the bill finds the payment. Without it the transfer arrives, but nothing settles.',
      'Once the chain confirms the transfer, the same link shows the share paid with a link to the transfer.',
    ],
    screen: '/pay/[token]',
    related: ['paying', 'shares'],
  },
  {
    id: 'tips',
    title: 'Tipping the fronter',
    summary:
      'A tip is a voluntary extra for whoever paid upfront. It is separate from the shares and settles directly to them.',
    audience: 'members',
    steps: [
      'Open the settled or locked expense.',
      'Choose the tip amount and an optional message.',
      'Send the transfer to the fronter’s account.',
    ],
    screen: '/groups/[id]/bill',
    related: ['expenses', 'paying'],
  },
  {
    id: 'late-fees',
    title: 'Late fees',
    summary:
      'If the group agreed to one, a share that misses its due date can carry a monthly late fee. It is a separate charge on top of the share and goes straight to the fronter.',
    audience: 'fronters',
    steps: [
      'Set the rule when the agreement is created: no late fee, or a % per month capped at a % of the share.',
      'Only the fronter can raise it, only after the due date, and only for the amount quoted when it was raised.',
      'The member pays it from the bill screen; the share stays a separate payment.',
    ],
    screen: '/groups/[id]/bill',
    related: ['paying', 'tips', 'expenses'],
  },
  {
    id: 'bounties',
    title: 'Bounties and the group DAO',
    summary:
      'Post work, pick who did it, and let the group DAO pay. Every payout is a proposal your own wallet signs.',
    audience: 'members',
    steps: [
      'Inside a group, tap Bounties and the group DAO.',
      'The owner or a fronter connects a Sputnik DAO by label and account — Creating your own DAO account walks through getting one. Read the policy stores its caps (Auto, Council, Period, Window); Sync refreshes roles and approvals.',
      'Post a bounty with a title, details, reward and category — it opens for the group to claim.',
      'Open lists unclaimed work, In progress holds claimed work, and Paid holds payouts the DAO has executed.',
      'Contributors shows the trust score that decides how much one person may approve.',
    ],
    screen: '/social/board/[group]',
    related: ['bounty', 'dao-account', 'group-detail', 'leaderboard'],
  },
  {
    id: 'dao-account',
    title: 'Creating your own DAO account',
    summary:
      'The board pays from a Sputnik DAO: a NEAR account running the DAO contract, which answers get_policy. Globie can mint one with your wallet, or you can connect one you built elsewhere.',
    audience: 'fronters',
    steps: [
      'A DAO account is an ordinary NEAR account with the Sputnik v2 contract deployed, so it answers get_policy with its roles and vote thresholds. A plain wallet account does not, so pasting one fails with “did not return JSON”.',
      'It has to be on the same network as this app. On testnet the account ends in .sputnikv2.testnet; on mainnet it ends in .sputnik-dao.near.',
      'Fastest route is in this app: on the web board tap Create a DAO with defaults, name it and tap Create with wallet. Globie calls create on the factory — sputnikv2.testnet on testnet, sputnik-dao.near on mainnet — with this group’s owners and fronters as the council, and the DAO appears at name.sputnikv2.testnet (or name.sputnik-dao.near).',
      'The wallet that signs pays for it: about 6 NEAR of storage deposit plus gas, so keep roughly 6.3 NEAR liquid. The factory refunds whatever the contract code does not use. If it answers “Sender … does not have enough balance”, top that account up and retry — Globie checks the balance first and says how much is missing.',
      'Phones have no wallet popup, so minting there needs the web build — or build the DAO in a DAO app such as Trezu and connect the wallet that will sit on the council.',
      'By hand, call create on the factory with a JSON body {"name":"<dao>","args":"<base64>"}, where <base64> is the init payload {"config":{"name":"…","purpose":"…","metadata":""},"policy":[council accounts]}. Attach 6 NEAR and 300 Tgas.',
      'The accounts inside policy become the council, so never leave a placeholder there — nobody could approve a payout.',
      'Back on Bounties, paste the account in DAO account, give it a label and tap Read the policy. The caps and roles are stored; Sync refreshes them later.',
    ],
    screen: '/social/board/[group]',
    related: ['bounties', 'bounty'],
  },
  {
    id: 'bounty',
    title: 'Claiming a bounty and getting paid',
    summary:
      'A claim moves from claimed to submitted, then a decision, then a DAO proposal. Money only moves when the DAO executes it.',
    audience: 'members',
    steps: [
      'Open a bounty from the board and tap Claim this bounty.',
      'When the work is done, write What you did, add a public Evidence link and tap Submit for review.',
      'The council approves or rejects. Approval opens the payout; a rejection closes the claim.',
      'Tap Preview the payout to see the tier: Auto-approved, One council approval, or Full DAO vote.',
      'On the web use Open wallet & propose. On a phone tap Freeze payout, sign in your wallet and paste the proposal hash.',
      'Tap Sync until the DAO has executed it — the claim is settled and the claimer’s trust goes up.',
    ],
    screen: '/social/[id]',
    related: ['bounties', 'leaderboard', 'globie'],
  },
  {
    id: 'shares',
    title: 'Shares',
    summary:
      'Shares is your own ledger: what you owe, what you are owed, and what has settled on NEAR.',
    audience: 'members',
    steps: [
      'Pending lines show money that is real but not collectable yet.',
      'Requested shares are ready to pay.',
      'Paid shares keep their NEAR transaction hash for your records.',
    ],
    screen: '/me/shares',
    related: ['paying', 'activity'],
  },
  {
    id: 'leaderboard',
    title: 'Hero board and Globie points',
    summary:
      'The hero board ranks members by Globie points — earned when a share is paid, not bought.',
    audience: 'members',
    steps: [
      'Open the group and tap the hero board.',
      'Points arrive when the share behind them is paid.',
      'Awarding points is a fronter action and asks for confirmation first.',
    ],
    screen: '/groups/[id]/leaderboard',
    related: ['group-detail', 'globie', 'bounty'],
  },
  {
    id: 'fund',
    title: 'Globie Fund — donate a tree',
    summary:
      'Donate adopts trees in the Isaan sanctuary. The gift goes straight from your own wallet to the sanctuary’s account, and the deed is written when the chain confirms it.',
    audience: 'members',
    steps: [
      'Open Donate and pick a tree — each card shows the need level and the price per tree, with an ≈ NEAR estimate.',
      'Choose how many trees (1, 2, 5 or 10) and, when there is a choice, USDC or NEAR.',
      'Tap Donate. The price is frozen into a quote first, and the quote is what you pay — the ≈ NEAR figure is only an estimate.',
      'On the web the wallet signs right away. On a phone send the exact amount to the treasury account shown, paste the transaction hash and tap Confirm payment.',
      'The deed (GLB-…) is written when the transfer clears; open a deed in Your giving to see it on NEAR.',
    ],
    screen: '/fund',
    related: ['globie', 'network', 'settings'],
  },
  {
    id: 'activity',
    title: 'Activity',
    summary:
      'Activity is the audit trail across your groups: bills read, splits proposed, shares confirmed, money sent.',
    audience: 'members',
    steps: [
      'Open Activity for the newest events first.',
      'Each row names who did what and in which group.',
      'Use it to check a disputed step before you message the group.',
    ],
    screen: '/me/activity',
    related: ['shares', 'group-detail'],
  },
  {
    id: 'settings',
    title: 'Settings',
    summary:
      'Your NEAR account, where Globie reaches you, and the notification switches for this device.',
    audience: 'members',
    steps: [
      'Check the NEAR account Globie will pay you at.',
      'Set the reminders you actually want.',
      'Help lives here too, if you need this manual again.',
    ],
    screen: '/settings',
    related: ['sign-in', 'globie'],
  },
  {
    id: 'globie',
    title: 'What Globie can and cannot do',
    summary:
      'Globie reads receipts, proposes splits, requests confirmation, asks for payment, reports status, sends reminders and awards points. It cannot move your money.',
    audience: 'members',
    steps: [
      'Ask in chat for an explanation and it answers from this manual.',
      'Money and people actions always show a confirmation you must accept.',
      'Every action is written to the group’s activity trail.',
      'If there is no page for your question, Globie says so instead of guessing.',
    ],
    screen: null,
    related: ['leaderboard', 'settings', 'fund', 'bounties'],
  },
];

const BY_ID = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]));

export function findTopic(id: string): HelpTopic | null {
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

/** Titles and summaries, for a caller that only needs the index. */
export function catalogue(): Array<Pick<HelpTopic, 'id' | 'title' | 'summary'>> {
  return HELP_TOPICS.map(({ id, title, summary }) => ({ id, title, summary }));
}

/**
 * Interrogatives, articles and prepositions. Without this list every
 * "what is …" question scored a hit on "What Globie can and cannot do" and
 * got that page instead of the honest catalogue answer.
 */
const STOPWORDS = new Set([
  'what',
  'which',
  'when',
  'where',
  'why',
  'who',
  'how',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'the',
  'and',
  'but',
  'for',
  'with',
  'your',
  'you',
  'our',
  'that',
  'this',
  'are',
  'was',
  'were',
  'has',
  'have',
  'from',
  'into',
  'about',
]);

/**
 * Deterministic keyword match over the catalogue. Deliberately dumb: a wrong
 * guess is worse than saying "no page for that", because the copy is returned
 * as the answer.
 */
export function matchTopic(question: string): HelpTopic | null {
  const text = question.toLowerCase();
  // Tokens let a prefix count: "how do I pay" should find "Paying your share".
  const tokens = text
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  let best: { topic: HelpTopic; score: number } | null = null;

  for (const topic of HELP_TOPICS) {
    const words = topic.title
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word));
    let score = 0;
    // A literal topic name ("tips", "activity") is the strongest signal.
    if (text.includes(topic.id.replace(/-/g, ' '))) score += 20;
    for (const word of words) {
      // Longer words are better evidence: "points" beats "work".
      if (text.includes(word)) score += word.length + 2;
      else if (tokens.some((token) => word.startsWith(token))) score += word.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }

  return best?.topic ?? null;
}
