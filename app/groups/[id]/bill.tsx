import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { SplitVotePanel } from '@/components/groups/split-vote-panel';
import { TxReceipt } from '@/components/ledger/tx-receipt';
import { Button, IconButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { downloadBillCsv } from '@/lib/api';
import { IS_WEB, WEB_ORIGIN } from '@/lib/config';
import { currencyExponent, formatMinor, fromMinor, toMinor } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import { payNearTransfer } from '@/lib/near';
import {
    useBill,
    useConfirmAllocation,
    useCreateBill,
    useCreateSharePayLink,
    useFinalizeBill,
    useGroup,
    useInterest,
    useNearStatus,
    useParseBill,
    useRaiseInterest,
    useRequestNearTransfer,
    useRequestTip,
    useSetAllocations,
    useSetClaims,
    useSettleInterest,
    useSettleTip,
    useTips,
    useUpdateBillItems,
    useUploadMedia
} from '@/lib/queries';
import type { Bill, BillItem, InterestCharge, Tip, TransferRequest } from '@/lib/types';

type Assignment = Record<string, string[]>;

/**
 * A line the fronter is retyping. Quantity and price stay strings so a
 * half-typed value is never rounded away mid-keystroke.
 */
type DraftLine = {
  key: string;
  id?: string;
  name: string;
  qty: string;
  price: string;
};

/** What a member's wallet needs to send one share; survives a page reload. */
type NearInstruction = {
  shareId: string;
  memberName: string;
  chainAmount: string;
  payTo: string;
  quoteRate: number | null;
  memo: string;
  tokenContract: string | null;
};

const statusCopy: Record<string, string> = {
  UPLOADED: 'Uploaded',
  PARSING: 'Reading the details',
  PARSED: 'Read, check the lines',
  ALLOCATED: 'Split proposed',
  CONFIRMED: 'Everyone confirmed',
  FINALIZED: 'Locked',
  COLLECTING: 'Collecting',
  SETTLED: 'Settled',
};
const collectedStatus = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);

/** Thank-you sizes, in major units, so the taps stay one-handed. */
const TIP_PRESETS = [toMinor(20), toMinor(50), toMinor(100)];

/** Basis points → the percent a person reads, without trailing zeros. */
function bpsToPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** A share is overdue once its due date has passed; the server re-checks anyway. */
function isOverdue(dueAt: string | null): boolean {
  return dueAt !== null && new Date(dueAt).getTime() < Date.now();
}

/**
 * What the total becomes if the draft is saved. Tax, service charge, tip and
 * discount stay exactly as printed, so only the lines move — the number on
 * screen will no longer match the paper receipt, and the card says so.
 */
function draftTotal(lines: DraftLine[], bill: Bill, exponent: number): number {
  const subtotal = lines.reduce((sum, line) => {
    const price = toMinor(line.price, exponent);
    const qty = Number(line.qty);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(qty) || qty <= 0) return sum;
    return sum + Math.round(price * qty);
  }, 0);
  return Math.max(
    0,
    subtotal + bill.taxMinor + bill.serviceChargeMinor + bill.tipMinor - bill.discountMinor
  );
}

export default function BillScreen() {
  const { id, billId } = useLocalSearchParams<{ id: string; billId?: string }>();
  const notify = useMascotToast();
  const money = useMoney();
  const group = useGroup(id);
  const activeBillId = billId ?? group.data?.bill?.id ?? '';

  const billQuery = useBill(activeBillId);
  const createBill = useCreateBill(id);
  const uploadMedia = useUploadMedia();
  const parseBill = useParseBill();
  const setAllocations = useSetAllocations();
  const updateBillItems = useUpdateBillItems();
  const setClaims = useSetClaims();
  const confirmAllocation = useConfirmAllocation();
  const finalize = useFinalizeBill(id);
  const requestNear = useRequestNearTransfer();
  const createPayLink = useCreateSharePayLink();
  const nearRail = useNearStatus();
  const requestTip = useRequestTip(activeBillId);
  const settleTip = useSettleTip(activeBillId);
  const interest = useInterest(activeBillId);
  const raiseInterest = useRaiseInterest(activeBillId);
  const settleInterest = useSettleInterest(activeBillId);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tipHash, setTipHash] = useState('');
  const [interestHash, setInterestHash] = useState('');
  const [nearSent, setNearSent] = useState<TransferRequest[]>([]);
  const [nearNotice, setNearNotice] = useState<string | null>(null);
  /** The lines the fronter is retyping; null while the bill is read-only. */
  const [draft, setDraft] = useState<{ key: string; lines: DraftLine[] } | null>(null);
  /** A rescan replaces every line, so the first tap only arms the second. */
  const [rescanArmed, setRescanArmed] = useState(false);

  const bill = billQuery.data?.bill;
  const locked = bill ? collectedStatus.has(bill.status) : false;
  /** The mode the group's votes resolve to right now; null until the bill loads. */
  const splitVote = billQuery.data?.splitVote;
  const equalMode = splitVote?.resolvedMode === 'equal';
  const tips = useTips(bill?.id ?? '', locked);
  const allocations = useMemo(() => billQuery.data?.allocations ?? [], [billQuery.data]);
  const shares = useMemo(() => billQuery.data?.shares ?? [], [billQuery.data]);
  const me = group.data?.me;
  const agreement = group.data?.agreement;
  const isFronter = Boolean(me && agreement?.frontedBy === me.id);
  const fronterName =
    group.data?.members.find((member) => member.id === agreement?.frontedBy)?.displayName ??
    'The fronter';
  const currency = bill?.currency ?? group.data?.group.defaultCurrency ?? 'THB';
  const exponent = currencyExponent(currency);
  const paidTips = (tips.data?.tips ?? []).filter((tip) => tip.status === 'paid');
  const myTip = tips.data?.myTip ?? null;

  // A late fee is owed on top of a share. The debtor's open charge comes first
  // because paying it is the one action this card can ask of them.
  const interestCharges = interest.data?.charges ?? [];
  const myCharge =
    interestCharges.find((charge) => charge.memberId === me?.id && charge.status === 'requested') ??
    interestCharges.find((charge) => charge.memberId === me?.id && charge.status === 'paid') ??
    null;
  const chargedShareIds = new Set(
    interestCharges.filter((charge) => charge.status !== 'waived').map((charge) => charge.shareId)
  );
  // The server decides for real; this only avoids offering a button that would
  // be refused because the share is already paid or has no due date yet.
  const overdueShares = shares.filter(
    (share) =>
      isOverdue(share.dueAt) &&
      share.status !== 'paid' &&
      share.status !== 'settled' &&
      share.status !== 'refunded' &&
      !chargedShareIds.has(share.id)
  );

  // A share still owes a transfer until it is `paid` or `settled`. `requested`
  // counts: the member has the instruction but has not signed yet.
  const nearAwaiting = useMemo(
    () =>
      shares.filter(
        (share) =>
          share.status === 'proposed' ||
          share.status === 'confirmed' ||
          share.status === 'requested' ||
          share.status === 'failed'
      ),
    [shares]
  );

  // Instructions come from the bill itself, so the fronter keeps the payee and
  // memo after a reload. Entries just returned by a request fill the gap until
  // the refetched bill carries them.
  const nearInstructions = useMemo<NearInstruction[]>(() => {
    const byId = new Map<string, NearInstruction>();
    for (const share of shares) {
      if (!share.payTo || !share.chainAmount || !share.memo) continue;
      byId.set(share.id, {
        shareId: share.id,
        memberName: share.memberName,
        chainAmount: share.chainAmount,
        payTo: share.payTo,
        quoteRate: share.quoteRate ?? null,
        memo: share.memo,
        tokenContract: share.tokenContract ?? null,
      });
    }
    for (const entry of nearSent) {
      if (byId.has(entry.shareId)) continue;
      byId.set(entry.shareId, {
        shareId: entry.shareId,
        memberName: shares.find((share) => share.id === entry.shareId)?.memberName ?? 'Member',
        chainAmount: entry.chainAmount,
        payTo: entry.payTo,
        quoteRate: entry.quoteRate ?? null,
        memo: entry.memo,
        tokenContract: entry.tokenContract || null,
      });
    }
    return [...byId.values()];
  }, [shares, nearSent]);

  // The server's allocation is the truth. A tap is an overlay on top of it, and
  // the overlay dies the moment the server's version of the bill changes.
  const syncKey = `${bill?.id ?? ''}:${bill?.status ?? ''}:${allocations.length}`;
  const [edits, setEdits] = useState<{ key: string; map: Assignment }>({ key: syncKey, map: {} });
  const localMap = useMemo(() => (edits.key === syncKey ? edits.map : {}), [edits, syncKey]);
  const assignment = useMemo(() => {
    const next: Assignment = {};
    for (const item of bill?.items ?? []) {
      next[item.id] =
        localMap[item.id] ??
        allocations
          .filter((allocation) => allocation.billItemId === item.id)
          .map((allocation) => allocation.memberId);
    }
    return next;
  }, [bill?.items, allocations, localMap]);

  const myPending = useMemo(
    () =>
      equalMode
        ? []
        : allocations.filter((a) => a.memberId === me?.id && a.status === 'proposed'),
    [allocations, me?.id, equalMode]
  );
  const pendingCount = allocations.filter((a) => a.status === 'proposed').length;

  // A group buy is split by quantity, not by tapping names: each member claims
  // their own units and the server re-shares the line across whoever claimed.
  const claimMode = bill?.source === 'quantity_claim';
  const claimKey = `${bill?.id ?? ''}:${bill?.status ?? ''}:${allocations
    .map((allocation) => `${allocation.id}:${allocation.qty}`)
    .join(',')}`;
  const serverClaims = useMemo(() => {
    const next: Record<string, number> = {};
    for (const item of bill?.items ?? []) {
      next[item.id] =
        allocations.find(
          (allocation) => allocation.billItemId === item.id && allocation.memberId === me?.id
        )?.qty ?? 0;
    }
    return next;
  }, [bill?.items, allocations, me?.id]);
  const [claimEdits, setClaimEdits] = useState<{ key: string; map: Record<string, number> }>({
    key: '',
    map: {},
  });
  const claims = useMemo(
    () => (claimEdits.key === claimKey ? { ...serverClaims, ...claimEdits.map } : serverClaims),
    [claimEdits, claimKey, serverClaims]
  );
  const claimDirty = Object.entries(claims).some(
    ([itemId, qty]) => (serverClaims[itemId] ?? 0) !== qty
  );

  function bumpClaim(item: BillItem, direction: 1 | -1) {
    const current = claims[item.id] ?? 0;
    // A tray is counted in whole units; a weight is claimed in halves.
    const step = Number.isInteger(item.qty) ? 1 : 0.5;
    const next =
      Math.min(Math.max(Math.round((current + step * direction) * 100) / 100, 0), item.qty);
    setClaimEdits({
      key: claimKey,
      map: { ...(claimEdits.key === claimKey ? claimEdits.map : {}), [item.id]: next },
    });
  }

  function projectedShare(item: BillItem, qty: number) {
    return item.qty > 0 ? Math.round((item.lineTotalMinor * qty) / item.qty) : item.lineTotalMinor;
  }

  async function saveClaims() {
    if (!bill) return;
    setBusy('claim');
    setError(null);
    try {
      await setClaims.mutateAsync({
        billId: bill.id,
        claims: Object.entries(claims).map(([billItemId, qty]) => ({ billItemId, qty })),
      });
      notify({ title: 'Claim saved', body: 'The line is split across whoever has claimed so far.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your claim');
    } finally {
      setBusy(null);
    }
  }

  async function capture(source: 'camera' | 'library') {
    setError(null);
    setBusy('capture');
    try {
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              quality: 0.85,
            });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const kind: 'photo' | 'video' = asset.type === 'video' ? 'video' : 'photo';

      let targetBillId = activeBillId;
      if (!targetBillId) {
        const agreement = group.data?.agreement;
        if (!agreement) throw new Error('Create the agreement first');
        const created = await createBill.mutateAsync({
          agreementId: agreement.id,
          currency: agreement.currency,
        });
        targetBillId = created.bill.id;
      }

      await uploadMedia.mutateAsync({
        billId: targetBillId,
        uri: asset.uri,
        kind,
        file: asset.file ?? undefined,
      });
      await parseBill.mutateAsync({ billId: targetBillId });
      notify({ title: 'Expense read', body: 'Kae Na checked every line. Confirm your share.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the expense');
    } finally {
      setBusy(null);
    }
  }

  function toggle(itemId: string, memberId: string) {
    const members = assignment[itemId] ?? [];
    setEdits({
      key: syncKey,
      map: {
        ...localMap,
        [itemId]: members.includes(memberId)
          ? members.filter((entry) => entry !== memberId)
          : [...members, memberId],
      },
    });
  }

  async function saveAssignments() {
    if (!bill) return;
    setBusy('assign');
    setError(null);
    try {
      const payload = Object.entries(assignment).flatMap(([billItemId, memberIds]) =>
        memberIds.map((memberId) => ({ billItemId, memberId, qty: 1 }))
      );
      await setAllocations.mutateAsync({ billId: bill.id, allocations: payload });
      notify({ title: 'Split proposed', body: 'Everyone gets a tap to confirm.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the split');
    } finally {
      setBusy(null);
    }
  }

  /** Copy the lines into editable text, keeping ids so the server updates in place. */
  function startEditing() {
    if (!bill) return;
    setError(null);
    setRescanArmed(false);
    setDraft({
      key: bill.id,
      lines: bill.items.map((item) => ({
        key: item.id,
        id: item.id,
        name: item.name,
        qty: String(item.qty),
        price: fromMinor(item.unitPriceMinor, exponent).toFixed(exponent),
      })),
    });
  }

  function addDraftLine() {
    setDraft((current) =>
      current
        ? {
            key: current.key,
            lines: [
              ...current.lines,
              {
                key: `new-${current.lines.length}-${Date.now()}`,
                name: '',
                qty: '1',
                price: '',
              },
            ],
          }
        : current
    );
  }

  function removeDraftLine(key: string) {
    setDraft((current) =>
      current
        ? { key: current.key, lines: current.lines.filter((line) => line.key !== key) }
        : current
    );
  }

  function setDraftField(key: string, field: 'name' | 'qty' | 'price', value: string) {
    setDraft((current) =>
      current
        ? {
            key: current.key,
            lines: current.lines.map((line) =>
              line.key === key ? { ...line, [field]: value } : line
            ),
          }
        : current
    );
  }

  async function saveDraftLines() {
    if (!bill || !draft) return;
    const items: { id?: string; name: string; qty: number; unitPriceMinor: number }[] = [];
    for (const line of draft.lines) {
      const name = line.name.trim();
      const qty = Number(line.qty);
      const unitPriceMinor = toMinor(line.price, exponent);
      if (!name) {
        setError('Every line needs a name.');
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`Give ${name} a quantity above zero.`);
        return;
      }
      if (!Number.isFinite(unitPriceMinor) || unitPriceMinor < 0) {
        setError(`Give ${name} a price, like 120 or 120.50.`);
        return;
      }
      items.push({ id: line.id, name, qty, unitPriceMinor });
    }
    if (items.length === 0) {
      setError('A bill needs at least one line.');
      return;
    }

    setBusy('items');
    setError(null);
    try {
      await updateBillItems.mutateAsync({ billId: bill.id, items });
      setDraft(null);
      notify({
        title: 'Lines corrected',
        body: 'The amounts moved — everyone confirms their own lines again.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the lines');
    } finally {
      setBusy(null);
    }
  }

  /**
   * A rescan uploads the new photo onto the same bill and lets the reader
   * replace every line; the server deletes the old items. `rescanArmed` asks
   * first, because that destroys whatever was already assigned.
   */
  async function rescan(source: 'camera' | 'library') {
    setRescanArmed(false);
    await capture(source);
  }

  async function confirmMine() {
    if (!bill) return;
    setBusy('confirm');
    try {
      for (const allocation of myPending) {
        await confirmAllocation.mutateAsync({ billId: bill.id, allocationId: allocation.id });
      }
      notify({ title: 'Share confirmed', body: 'Kae Na has your tap on record.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm');
    } finally {
      setBusy(null);
    }
  }

  async function runFinalize() {
    if (!bill) return;
    setBusy('finalize');
    setError(null);
    try {
      await finalize.mutateAsync({ billId: bill.id });
      notify({ title: 'Bill locked', body: 'Nobody edits it now — time to collect.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not lock the bill');
    } finally {
      setBusy(null);
    }
  }

  /**
   * A share is one NEP-141 transfer, so the request fans out one share at a
   * time. A member with no linked account blocks only their own share; the rest
   * still go out, and the blocked ones are named here rather than dropped.
   */
  async function runRequestNearTransfers() {
    // Nothing outstanding used to return silently, which reads as a dead
    // button. Say why instead.
    if (nearAwaiting.length === 0) {
      const settled = shares.length - nearAwaiting.length;
      setError(null);
      setNearNotice(
        settled > 0
          ? `All ${settled} ${settled === 1 ? 'share is' : 'shares are'} already paid — nothing left to request.`
          : 'This bill has no shares to request yet.'
      );
      return;
    }
    // `requested` is included so a second tap re-renders the payee and memo for
    // copies that were lost; the server answers it with `alreadyRequested`.
    setBusy('near');
    setError(null);
    setNearNotice(null);
    const sent: TransferRequest[] = [];
    const blocked: string[] = [];
    try {
      for (const share of nearAwaiting) {
        try {
          sent.push(await requestNear.mutateAsync({ shareId: share.id }));
        } catch (cause) {
          blocked.push(
            `${share.memberName}: ${cause instanceof Error ? cause.message : 'not requested'}`
          );
        }
      }
      // Merge, never replace: a partial retry keeps the earlier instructions.
      setNearSent((previous) => {
        const byId = new Map(previous.map((entry) => [entry.shareId, entry]));
        for (const entry of sent) byId.set(entry.shareId, entry);
        return [...byId.values()];
      });
      if (sent.length > 0) {
        const fresh = sent.filter((entry) => !entry.alreadyRequested).length;
        const again = sent.length - fresh;
        setNearNotice(
          fresh > 0
            ? `Requested ${fresh} transfer${fresh === 1 ? '' : 's'}${
                again > 0 ? ` · ${again} already requested` : ''
              }.`
            : again === 1
              ? 'That instruction was already requested — the payee and memo below are current.'
              : `All ${again} instructions were already requested — the payee and memo below are current.`
        );
        notify({
          title: fresh > 0 ? 'NEAR transfers requested' : 'Already requested',
          body:
            fresh > 0
              ? 'Each member pays from My shares, straight to your account.'
              : 'Share the payee and memo below with the member; nothing else changed.',
        });
      }
      if (blocked.length > 0) setError(blocked.join('\n'));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A link instead of an install: whoever opens it reads the same frozen
   * amount, payee and memo this card shows. The web has no dependable share
   * sheet, so the URL goes to the clipboard; a phone hands it to the share
   * sheet.
   */
  async function sharePayLink(shareId: string) {
    setBusy('link');
    setError(null);
    try {
      const link = await createPayLink.mutateAsync(shareId);
      const url = `${WEB_ORIGIN}${link.path}`;
      if (IS_WEB) {
        await Clipboard.setStringAsync(url);
      } else {
        await Share.share({ message: url, title: 'Pay your share' });
      }
      notify({
        title: IS_WEB ? 'Pay link copied' : 'Pay link ready',
        body: 'Anyone who opens it sees the amount, the payee and the memo — no account needed.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the pay link');
    } finally {
      setBusy(null);
    }
  }

  /**
   * A tip is a NEP-141 transfer of its own: the request hands the member the
   * payee, the amount and the memo, and the card below collects the hash.
   */
  async function tipFronter(amountMinor: number) {
    if (!bill) return;
    setBusy('tip');
    setError(null);
    setTipHash('');
    try {
      await requestTip.mutateAsync({ amountMinor });
      notify({
        title: 'Tip ready',
        body: 'One USDC transfer from your own wallet settles it.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the tip');
    } finally {
      setBusy(null);
    }
  }

  /** The API reads the receipt for a tip that was paid on chain. */
  async function recordTip(tipId: string, hash: string) {
    setBusy('tip');
    setError(null);
    try {
      const result = await settleTip.mutateAsync({ tipId, txHash: hash });
      setTipHash('');
      notify({
        title: 'Tip sent',
        body:
          result.pointsAwarded > 0
            ? `Kae Na thanks you — +${result.pointsAwarded} Globie`
            : 'Kae Na thanks you.',
        points: result.pointsAwarded,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not verify the tip');
    } finally {
      setBusy(null);
    }
  }

  /** Native: the wallet handed back a hash, so the member pastes it here. */
  async function settleTipNow(tipId: string) {
    const hash = tipHash.trim();
    if (!hash) return;
    await recordTip(tipId, hash);
  }

  /**
   * Web: the wallet pops up over this screen and signs the transfer, so the
   * hash comes back on its own — no copy-paste, no leaving the app.
   */
  async function payTipNow(tip: Tip) {
    if (!tip.payTo || !tip.chainAmount) return;
    setBusy('tip');
    setError(null);
    try {
      const outcome = await payNearTransfer({
        receiverId: tip.payTo,
        amount: tip.chainAmount,
        memo: tip.memo,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setError(outcome.message);
        return;
      }
      await recordTip(tip.id, outcome.txHash);
    } finally {
      setBusy(null);
    }
  }

  /**
   * The fronter raises the agreed fee on an overdue share. The server computes
   * the amount from the days late and freezes its USDC quote right there.
   */
  async function raiseLateFee(shareId: string) {
    setBusy('interest');
    setError(null);
    setInterestHash('');
    try {
      await raiseInterest.mutateAsync(shareId);
      notify({
        title: 'Late fee raised',
        body: 'The member now owes it on top of their share.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not raise the late fee');
    } finally {
      setBusy(null);
    }
  }

  /** The API reads the receipt; the share stays a separate payment. */
  async function recordLateFee(chargeId: string, hash: string) {
    setBusy('interest');
    setError(null);
    try {
      const result = await settleInterest.mutateAsync({ chargeId, txHash: hash });
      setInterestHash('');
      notify({
        title: 'Late fee paid',
        body: result.alreadyPaid
          ? 'That transfer was already recorded.'
          : 'The fronter has it. Your share is still its own payment.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not verify the late fee');
    } finally {
      setBusy(null);
    }
  }

  /** Native: paste the hash the wallet produced. */
  async function settleLateFeeNow(chargeId: string) {
    const hash = interestHash.trim();
    if (!hash) return;
    await recordLateFee(chargeId, hash);
  }

  /**
   * Web: the wallet signs the frozen USDC amount to the fronter's account and
   * the hash comes back on its own.
   */
  async function payLateFeeNow(charge: InterestCharge) {
    if (!charge.payTo || !charge.chainAmount) return;
    setBusy('interest');
    setError(null);
    try {
      const outcome = await payNearTransfer({
        receiverId: charge.payTo,
        amount: charge.chainAmount,
        memo: charge.memo,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setError(outcome.message);
        return;
      }
      await recordLateFee(charge.id, outcome.txHash);
    } finally {
      setBusy(null);
    }
  }

  /**
   * The bill as a spreadsheet. The API answers with a bearer-authenticated
   * body, so a plain link cannot fetch it — the file is assembled here. Web
   * saves it; native has no downloads folder, so the share sheet carries the
   * same bytes to Files, Mail or a spreadsheet app.
   */
  async function exportCsv() {
    if (!bill) return;
    setBusy('csv');
    setError(null);
    try {
      const file = await downloadBillCsv(bill.id);
      if (IS_WEB) {
        const url = URL.createObjectURL(
          new Blob([file.body], { type: 'text/csv;charset=utf-8' })
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: file.body, title: file.filename });
      }
      notify({
        title: IS_WEB ? 'Spreadsheet downloaded' : 'Spreadsheet ready',
        body: `${file.filename} · one row per share.`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export the bill');
    } finally {
      setBusy(null);
    }
  }

  if (group.isLoading || (activeBillId && billQuery.isLoading)) {
    return (
      <Screen scroll={false} header={{ title: 'Expense', back: true }}>
        <Skeleton height={28} width="50%" />
        <Skeleton height={96} />
        <Skeleton height={120} />
        <Skeleton height={72} />
      </Screen>
    );
  }

  if (group.error || !group.data) {
    return (
      <Screen scroll={false} header={{ title: 'Expense', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Group unavailable"
          body={group.error?.message ?? 'This group is gone, or the link is wrong.'}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => group.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  if (billQuery.error) {
    return (
      <Screen scroll={false} header={{ title: 'Expense', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Could not load the expense"
          body={billQuery.error.message}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => billQuery.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={{
        title: bill?.merchant ?? 'Expense',
        subtitle: bill
          ? `${group.data.group.name} · ${statusCopy[bill.status] ?? bill.status}`
          : group.data.group.name,
        back: true,
      }}
      bottomInset={space.xl}
    >

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.alert} size={15} color={colors.danger} />
            <Text variant="label" tone="danger">
              That step did not go through
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}

      {!isFronter && (!bill || (!locked && bill.items.length === 0)) ? (
        <Card>
          <SectionHeading
            glyph={icon.time}
            title="Waiting for the details"
            hint={`${fronterName} is fronting this expense and will add it. Your lines show up here once the split is proposed.`}
          />
        </Card>
      ) : null}

      {isFronter && (!bill || (!locked && bill.items.length === 0)) ? (
        <Card tone="accent">
          <SectionHeading
            glyph={bill ? icon.upload : icon.camera}
            title={bill ? 'Upload the expense' : 'Capture the expense'}
            hint={
              bill
                ? 'A photo of the receipt or invoice is enough. Pick one you already have.'
                : 'A photo is enough. A short video works too: we sample frames and reconcile them into one list.'
            }
          />
          <Button
            title="Take a photo"
            icon={icon.camera}
            onPress={() => capture('camera')}
            loading={busy === 'capture'}
          />
          <Button
            title="Pick a photo or video"
            variant="secondary"
            icon={icon.images}
            onPress={() => capture('library')}
            loading={busy === 'capture'}
          />
        </Card>
      ) : null}

      {bill ? (
        <>
          <Card>
            <View style={styles.rowBetween}>
              <View style={styles.flex}>
                <Text variant="label" tone="muted">
                  Total
                </Text>
                <Text variant="figure">{money.format(bill.totalMinor, currency)}</Text>
              </View>
              <View style={[styles.badge, locked && styles.badgeDone]}>
                <Icon
                  name={locked ? icon.lock : icon.sync}
                  size={12}
                  color={locked ? colors.accent : colors.muted}
                />
                <Text variant="caption" tone={locked ? 'accent' : 'muted'}>
                  {statusCopy[bill.status] ?? bill.status}
                </Text>
              </View>
            </View>
            <Text variant="caption" tone="muted">
              {money.approximate(bill.totalMinor, currency)
                ? `${money.formatOriginal(bill.totalMinor, currency)} · `
                : ''}
              {bill.items.length} {bill.items.length === 1 ? 'item' : 'items'}
              {bill.framesExtracted > 1
                ? `, reconciled from ${bill.framesExtracted} video frames`
                : ''}
            </Text>
            {bill.warnings.map((warning) => (
              <Text key={warning} variant="caption" tone="warn">
                {warning}
              </Text>
            ))}
            {shares.length > 0 ? (
              <View style={styles.exportRow}>
                <Button
                  title="Export CSV"
                  variant="secondary"
                  compact
                  icon={icon.receipt}
                  onPress={() => void exportCsv()}
                  loading={busy === 'csv'}
                />
                <Text variant="caption" tone="dim" style={styles.flex}>
                  One row per share — amounts, frozen USDC quote and the transfer hash.
                </Text>
              </View>
            ) : null}
            <SplitVotePanel
              groupId={id}
              agreementId={agreement?.id}
              billId={bill.id}
              summary={splitVote}
              disabled={locked}
            />
          </Card>

          {equalMode && bill.items.length > 0 ? (
            <Card>
              <SectionHeading
                glyph={icon.people}
                title="Split evenly"
                hint={`The group chose to divide this bill equally, so there is nothing to assign. Each of the ${
                  splitVote?.memberCount ?? group.data?.members.length ?? 0
                } members gets the same share when it is locked.`}
              />
            </Card>
          ) : null}

          {bill.status === 'PARSING' ? (
            <Card>
              <SectionHeading glyph={icon.scan} title="Reading the details" hint="This takes a moment." />
              <Skeleton height={20} width="72%" />
              <Skeleton height={20} width="48%" />
            </Card>
          ) : null}

          {!equalMode && bill.items.length > 0 ? (
            <View style={styles.section}>
              <SectionHeading
                glyph={icon.receipt}
                title={claimMode ? 'Who is taking what' : 'Who had what'}
                hint={
                  claimMode
                    ? `Each member claims the units they want. Anything left unclaimed stays with ${fronterName}.`
                    : isFronter
                      ? 'Tap a name on every item to assign it. Each member confirms their own lines.'
                      : `${fronterName} is splitting this. You will confirm your own lines below.`
                }
              />
              {bill.items.map((item, index) => (
                <Card key={item.id} enter={index + 1} style={styles.itemCard}>
                  <View style={styles.rowBetween}>
                    <Text variant="label" style={styles.flex}>
                      {item.qty > 1 ? `${item.qty}× ` : ''}
                      {item.name}
                      {claimMode && item.unit ? (
                        <Text variant="caption" tone="dim">
                          {' '}
                          available in {item.unit}
                        </Text>
                      ) : null}
                    </Text>
                    <View style={styles.amount}>
                      <Text variant="mono">{money.format(item.lineTotalMinor, currency)}</Text>
                      {money.approximate(item.lineTotalMinor, currency) ? (
                        <Text variant="caption" tone="dim" style={styles.amountNote}>
                          {money.formatOriginal(item.lineTotalMinor, currency)}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  {claimMode ? (
                    <View style={styles.claimBlock}>
                      {!locked ? (
                        <View style={styles.claimRow}>
                          <Button
                            compact
                            variant="secondary"
                            title="−"
                            accessibilityLabel={`Claim one fewer of ${item.name}`}
                            onPress={() => bumpClaim(item, -1)}
                          />
                          <View style={styles.claimValue}>
                            <Text variant="mono">{claims[item.id] ?? 0}</Text>
                            <Text variant="caption" tone="dim">
                              {item.unit ?? 'unit'}
                            </Text>
                          </View>
                          <Button
                            compact
                            variant="secondary"
                            title="+"
                            accessibilityLabel={`Claim one more of ${item.name}`}
                            onPress={() => bumpClaim(item, 1)}
                          />
                          <Text variant="caption" tone="muted" style={styles.flex}>
                            your share{' '}
                            {money.format(projectedShare(item, claims[item.id] ?? 0), currency)}
                          </Text>
                        </View>
                      ) : null}
                      <Text variant="caption" tone="muted">
                        {allocations
                          .filter((allocation) => allocation.billItemId === item.id)
                          .map((allocation) => `${allocation.memberName} ×${allocation.qty}`)
                          .join(' · ') || 'Nobody claimed yet'}
                      </Text>
                    </View>
                  ) : isFronter ? (
                    <View style={styles.chips}>
                      {(group.data?.members ?? []).map((member) => {
                        const selected = (assignment[item.id] ?? []).includes(member.id);
                        return (
                          <Button
                            key={member.id}
                            compact
                            variant={selected ? 'primary' : 'secondary'}
                            icon={selected ? icon.check : undefined}
                            title={member.displayName}
                            accessibilityLabel={`${member.displayName}, ${
                              selected ? 'on this item' : 'not on this item'
                            }`}
                            onPress={() => toggle(item.id, member.id)}
                          />
                        );
                      })}
                    </View>
                  ) : (
                    <Text variant="caption" tone="muted">
                      {(assignment[item.id] ?? [])
                        .map(
                          (memberId) =>
                            (group.data?.members ?? []).find((member) => member.id === memberId)
                              ?.displayName
                        )
                        .filter(Boolean)
                        .join(', ') || 'Not assigned yet'}
                    </Text>
                  )}
                  {item.confidence < 0.8 ? (
                    <View style={styles.warnRow}>
                      <Icon name={icon.warning} size={13} color={colors.warn} />
                      <Text variant="caption" tone="warn" style={styles.flex}>
                        Low confidence in this line. Check the amount.
                      </Text>
                    </View>
                  ) : null}
                </Card>
              ))}
              {claimMode ? (
                !locked ? (
                  <Button
                    title={claimDirty ? 'Save claim' : 'Claim saved'}
                    variant={claimDirty ? 'primary' : 'secondary'}
                    icon={icon.checkDone}
                    disabled={!claimDirty}
                    onPress={saveClaims}
                    loading={busy === 'claim'}
                  />
                ) : null
              ) : isFronter ? (
                <Button
                  title="Save split"
                  variant="secondary"
                  icon={icon.checkDone}
                  onPress={saveAssignments}
                  loading={busy === 'assign'}
                />
              ) : null}
            </View>
          ) : null}

          {isFronter && !locked && bill.items.length > 0 ? (
            <Card>
              <SectionHeading
                glyph={icon.edit}
                title="Wrong on the receipt?"
                hint="Rename a line the reader misread, change a quantity or price, drop a line, or add one it missed. Tax, service and tip stay exactly as printed."
              />
              {draft ? (
                <>
                  {draft.lines.map((line) => (
                    <View key={line.key} style={styles.draftLine}>
                      <View style={styles.rowBetween}>
                        <View style={styles.flex}>
                          <Field
                            label="Item"
                            value={line.name}
                            onChangeText={(value) => setDraftField(line.key, 'name', value)}
                            placeholder="What it was"
                          />
                        </View>
                        <IconButton
                          name={icon.trash}
                          label={`Remove ${line.name || 'this line'}`}
                          tone="danger"
                          onPress={() => removeDraftLine(line.key)}
                        />
                      </View>
                      <View style={styles.draftNumbers}>
                        <View style={styles.flex}>
                          <Field
                            label="Qty"
                            value={line.qty}
                            onChangeText={(value) => setDraftField(line.key, 'qty', value)}
                            keyboardType="decimal-pad"
                          />
                        </View>
                        <View style={styles.flex}>
                          <Field
                            label={`Price (${currency})`}
                            value={line.price}
                            onChangeText={(value) => setDraftField(line.key, 'price', value)}
                            keyboardType="decimal-pad"
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                  <Button
                    title="Add a line"
                    variant="secondary"
                    icon={icon.add}
                    onPress={addDraftLine}
                  />
                  <Text variant="caption" tone="warn">
                    New total {money.format(draftTotal(draft.lines, bill, exponent), currency)} — tax,
                    service and tip are untouched, so it will not match the paper receipt.
                  </Text>
                  <Button
                    title="Save these lines"
                    icon={icon.checkDone}
                    onPress={saveDraftLines}
                    loading={busy === 'items'}
                  />
                  <Button
                    title="Leave them as they are"
                    variant="ghost"
                    onPress={() => setDraft(null)}
                  />
                </>
              ) : rescanArmed ? (
                <>
                  <Text variant="body">
                    {bill.items.length} {bill.items.length === 1 ? 'line' : 'lines'} will be replaced
                    with what the reader sees, and any assignment on them cleared.
                  </Text>
                  <Button
                    title="Take a new photo"
                    icon={icon.camera}
                    onPress={() => void rescan('camera')}
                    loading={busy === 'capture'}
                  />
                  <Button
                    title="Pick a photo or video"
                    variant="secondary"
                    icon={icon.images}
                    onPress={() => void rescan('library')}
                    loading={busy === 'capture'}
                  />
                  <Button
                    title="Keep the current lines"
                    variant="ghost"
                    onPress={() => setRescanArmed(false)}
                  />
                </>
              ) : (
                <>
                  <Button
                    title="Edit the lines"
                    variant="secondary"
                    icon={icon.edit}
                    onPress={startEditing}
                  />
                  <Button
                    title="Rescan the receipt"
                    variant="ghost"
                    icon={icon.refresh}
                    onPress={() => setRescanArmed(true)}
                  />
                </>
              )}
            </Card>
          ) : null}

          {myPending.length > 0 ? (
            <Card tone="accent">
              <SectionHeading
                glyph={icon.person}
                title="Confirm your share"
                hint="Only you can confirm your own lines."
              />
              {myPending.map((allocation) => (
                <View key={allocation.id} style={styles.rowBetween}>
                  <Text variant="body" style={styles.flex}>
                    {allocation.itemName}
                  </Text>
                  <View style={styles.amount}>
                    <Text variant="mono">{money.format(allocation.amountMinor, currency)}</Text>
                    {money.approximate(allocation.amountMinor, currency) ? (
                      <Text variant="caption" tone="dim" style={styles.amountNote}>
                        {money.formatOriginal(allocation.amountMinor, currency)}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              <Button
                title="These are mine"
                icon={icon.check}
                onPress={confirmMine}
                loading={busy === 'confirm'}
              />
            </Card>
          ) : null}

          {isFronter && !locked && (equalMode || (pendingCount === 0 && allocations.length > 0)) ? (
            <Card>
              <SectionHeading
                glyph={icon.lock}
                title="Lock the bill"
                hint={
                  equalMode
                    ? 'The split is even, so there is nothing left to confirm. Locking turns it into shares and starts the Globie race.'
                    : 'Every line is confirmed. Locking turns the split into shares and starts the Globie race.'
                }
              />
              <Button
                title="Lock the bill"
                icon={icon.lock}
                onPress={runFinalize}
                loading={busy === 'finalize'}
              />
            </Card>
          ) : null}

          {!isFronter && (bill.status === 'FINALIZED' || bill.status === 'COLLECTING') ? (
            <Card>
              <SectionHeading
                glyph={icon.near}
                title="Reimbursement"
                hint={`${fronterName} paid upfront. Pay your share from the My shares tab — the transfer names them as the payee, not Globie.`}
              />
            </Card>
          ) : null}

          {isFronter &&
          nearRail.data?.configured &&
          (bill.status === 'FINALIZED' || bill.status === 'COLLECTING') ? (
            <Card>
              <SectionHeading
                glyph={icon.near}
                title="Request on NEAR"
                hint={`Members send USDC on ${nearRail.data.network} to your account, signed in their own wallet. Globie only reads the chain.`}
              />
              <Button
                title="Request NEAR transfers"
                icon={icon.near}
                onPress={runRequestNearTransfers}
                loading={busy === 'near'}
              />
              <View accessibilityLiveRegion="polite">
                <Text variant="caption" tone="dim">
                  {nearAwaiting.length > 0
                    ? `${nearAwaiting.length} of ${shares.length} ${
                        shares.length === 1 ? 'share' : 'shares'
                      } still await a transfer.`
                    : shares.length > 0
                      ? 'Every share on this bill is paid.'
                      : 'No shares yet — lock the bill first.'}
                </Text>
                {nearNotice ? (
                  <Text variant="caption" tone="dim">
                    {nearNotice}
                  </Text>
                ) : null}
              </View>
              {nearInstructions.length > 0 ? (
                <View style={styles.nearList}>
                  {nearInstructions.map((entry) => {
                    const entryShare = shares.find((share) => share.id === entry.shareId);
                    return (
                      <View key={entry.shareId} style={styles.nearEntry}>
                        <View style={styles.rowBetween}>
                          <View style={styles.flex}>
                            <Text variant="body">{entryShare?.memberName ?? 'Member'}</Text>
                            <Text variant="caption" tone="dim">
                              {entry.chainAmount} USDC to {entry.payTo}
                            </Text>
                            {entry.quoteRate ? (
                              <Text variant="caption" tone="dim">
                                Locked at 1 {currency} = ${entry.quoteRate.toFixed(4)}
                              </Text>
                            ) : null}
                            <Text variant="caption" tone="dim">
                              Memo {entry.memo}
                              {entry.tokenContract ? ` · token ${entry.tokenContract}` : ''}
                            </Text>
                          </View>
                          <View style={styles.nearActions}>
                            <Button
                              variant="ghost"
                              compact
                              icon={icon.copy}
                              title="Copy memo"
                              onPress={() => {
                                void Clipboard.setStringAsync(entry.memo);
                                notify({
                                  title: 'Memo copied',
                                  body: 'Attach it to the transfer so the payment finds this share.',
                                });
                              }}
                            />
                            <Button
                              variant="ghost"
                              compact
                              icon={icon.share}
                              title="Share link"
                              accessibilityLabel={`Share a pay link for ${
                                entryShare?.memberName ?? 'this member'
                              }`}
                              disabled={busy === 'link'}
                              onPress={() => void sharePayLink(entry.shareId)}
                            />
                          </View>
                        </View>
                        {entryShare?.settlementTxHash ? (
                          <TxReceipt txHash={entryShare.settlementTxHash} />
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </Card>
          ) : null}

          {interest.data &&
          (interest.data.mode === 'monthly' || interestCharges.length > 0) ? (
            <Card>
              <SectionHeading
                glyph={icon.time}
                title="Late fee"
                hint={
                  interest.data.mode === 'monthly' && interest.data.rateBps
                    ? `${bpsToPercent(interest.data.rateBps)} per month once a share is past its due date${
                        interest.data.capBps
                          ? `, capped at ${bpsToPercent(interest.data.capBps)} of the share`
                          : ''
                      }. Agreed when the bill was created.`
                    : 'No late fee was agreed for this expense.'
                }
              />

              {myCharge && myCharge.status === 'requested' ? (
                <>
                  <View style={styles.rowBetween}>
                    <Text variant="body" style={styles.flex}>
                      You owe a late fee
                    </Text>
                    <Text variant="mono">{money.format(myCharge.amountMinor, currency)}</Text>
                  </View>
                  <Text variant="caption" tone="dim">
                    {myCharge.daysLate} {myCharge.daysLate === 1 ? 'day' : 'days'} late ·{' '}
                    {bpsToPercent(myCharge.rateBps)} per month. Your share is a separate payment.
                  </Text>
                  {myCharge.payTo && myCharge.chainAmount ? (
                    <View style={styles.nearList}>
                      <Text variant="caption" tone="dim">
                        {IS_WEB
                          ? 'Approve the transfer in the wallet window — it opens over this screen'
                          : 'Send this from your own NEAR wallet'}
                      </Text>
                      <Text variant="mono">
                        {myCharge.chainAmount} USDC to {myCharge.payTo}
                      </Text>
                      {myCharge.quoteRate && myCharge.quoteAsOf ? (
                        <Text variant="caption" tone="dim">
                          {money.formatOriginal(myCharge.amountMinor, currency)} locked at 1{' '}
                          {currency} = ${myCharge.quoteRate.toFixed(4)} on{' '}
                          {new Date(myCharge.quoteAsOf).toLocaleDateString()}
                        </Text>
                      ) : null}
                      <View style={styles.rowBetween}>
                        <Text
                          variant="caption"
                          tone="dim"
                          style={styles.flex}
                          numberOfLines={1}
                        >
                          Memo: {myCharge.memo}
                        </Text>
                        <Button
                          title="Copy memo"
                          compact
                          variant="ghost"
                          icon={icon.copy}
                          onPress={() => {
                            void Clipboard.setStringAsync(myCharge.memo);
                            notify({
                              title: 'Memo copied',
                              body: 'Attach it so this transfer is read as the late fee.',
                            });
                          }}
                        />
                      </View>
                      {IS_WEB ? (
                        <Button
                          title={`Pay ${myCharge.chainAmount} USDC`}
                          icon={icon.near}
                          loading={busy === 'interest'}
                          disabled={busy === 'interest'}
                          onPress={() => void payLateFeeNow(myCharge)}
                        />
                      ) : (
                        <>
                          <Field
                            label="NEAR transaction hash"
                            hint="Copy it from your wallet right after the transfer. Globie only reads the chain."
                            value={interestHash}
                            onChangeText={setInterestHash}
                            autoCapitalize="none"
                            autoCorrect={false}
                            spellCheck={false}
                            placeholder="2YbZa…"
                            returnKeyType="done"
                            onSubmitEditing={() => void settleLateFeeNow(myCharge.id)}
                          />
                          <Button
                            title="Confirm late fee"
                            compact
                            icon={icon.check}
                            loading={busy === 'interest'}
                            disabled={interestHash.trim().length === 0 || busy === 'interest'}
                            onPress={() => void settleLateFeeNow(myCharge.id)}
                          />
                        </>
                      )}
                    </View>
                  ) : (
                    <Text variant="caption" tone="muted">
                      {interest.data.frontedByName} has not linked a NEAR account, so settle this
                      with them directly.
                    </Text>
                  )}
                </>
              ) : myCharge?.status === 'paid' ? (
                <View style={styles.nearEntry}>
                  <View style={styles.rowBetween}>
                    <Text variant="body" style={styles.flex}>
                      Your late fee is paid
                    </Text>
                    <Text variant="mono">{money.format(myCharge.amountMinor, currency)}</Text>
                  </View>
                  {myCharge.settlementTxHash ? (
                    <TxReceipt txHash={myCharge.settlementTxHash} />
                  ) : null}
                </View>
              ) : null}

              {interest.data.canRaise ? (
                overdueShares.length > 0 ? (
                  <View style={styles.nearList}>
                    <Text variant="caption" tone="dim">
                      These shares are past their due date. Raising the fee freezes its USDC
                      amount.
                    </Text>
                    {overdueShares.map((share) => (
                      <View key={share.id} style={styles.rowBetween}>
                        <Text variant="body" style={styles.flex}>
                          {share.memberName}
                        </Text>
                        <Button
                          compact
                          variant="secondary"
                          icon={icon.time}
                          title="Raise fee"
                          accessibilityLabel={`Raise the late fee for ${share.memberName}`}
                          disabled={busy === 'interest'}
                          onPress={() => void raiseLateFee(share.id)}
                        />
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text variant="caption" tone="muted">
                    No share is overdue yet.
                  </Text>
                )
              ) : null}

              {interestCharges
                .filter((charge) => charge.id !== myCharge?.id)
                .map((charge) => (
                  <View key={charge.id} style={styles.nearEntry}>
                    <View style={styles.rowBetween}>
                      <Text variant="caption" style={styles.flex}>
                        {charge.memberName} · {charge.daysLate}d late
                        {charge.status === 'paid'
                          ? ' · paid'
                          : charge.status === 'waived'
                            ? ' · waived'
                            : ''}
                      </Text>
                      <Text variant="mono">{money.format(charge.amountMinor, currency)}</Text>
                    </View>
                    {charge.settlementTxHash ? (
                      <TxReceipt txHash={charge.settlementTxHash} />
                    ) : null}
                  </View>
                ))}

              {interest.data.totalMinor > 0 ? (
                <Text variant="caption" tone="accent">
                  {money.format(interest.data.totalMinor, currency)} in late fees collected
                </Text>
              ) : null}
            </Card>
          ) : null}

          {locked && tips.data ? (
            <Card>
              <SectionHeading
                glyph={icon.hand}
                title="Tip the fronter"
                hint={`${tips.data.frontedByName} fronted this expense. A tip is a thank-you, on top of your share.`}
              />
              {myTip && myTip.status === 'failed' ? (
                <>
                  <Text variant="body">
                    That transfer didn&apos;t go through, so nothing was sent. Try again
                    with one of these amounts.
                  </Text>
                  {tips.data.canTip ? (
                    <View style={styles.chips}>
                      {TIP_PRESETS.map((amountMinor) => (
                        <Button
                          key={amountMinor}
                          compact
                          variant="secondary"
                          icon={icon.hand}
                          title={formatMinor(amountMinor, currency)}
                          accessibilityLabel={`Tip ${formatMinor(amountMinor, currency)}`}
                          onPress={() => tipFronter(amountMinor)}
                          disabled={busy === 'tip'}
                        />
                      ))}
                    </View>
                  ) : null}
                </>
              ) : myTip && myTip.status === 'requested' ? (
                <>
                  <View style={styles.rowBetween}>
                    <Text variant="body" style={styles.flex}>
                      Your tip is one transfer away
                    </Text>
                    <Text variant="mono">{money.format(myTip.amountMinor, currency)}</Text>
                  </View>
                  {myTip.payTo && myTip.chainAmount ? (
                    <View style={styles.nearList}>
                      <Text variant="caption" tone="dim">
                        {IS_WEB
                          ? 'Approve the transfer in the wallet window — it opens over this screen'
                          : 'Send this from your own NEAR wallet'}
                      </Text>
                      <Text variant="mono">
                        {myTip.chainAmount} USDC to {myTip.payTo}
                      </Text>
                      {myTip.quoteRate && myTip.quoteAsOf ? (
                        <Text variant="caption" tone="dim">
                          {money.formatOriginal(myTip.amountMinor, currency)} locked at 1{' '}
                          {currency} = ${myTip.quoteRate.toFixed(4)} on{' '}
                          {new Date(myTip.quoteAsOf).toLocaleDateString()}
                        </Text>
                      ) : null}
                      {myTip.memo ? (
                        <View style={styles.rowBetween}>
                          <Text
                            variant="caption"
                            tone="dim"
                            style={styles.flex}
                            numberOfLines={1}
                          >
                            Memo: {myTip.memo}
                          </Text>
                          <Button
                            title="Copy memo"
                            compact
                            variant="ghost"
                            icon={icon.copy}
                            onPress={() => {
                              void Clipboard.setStringAsync(myTip.memo ?? '');
                              notify({
                                title: 'Memo copied',
                                body: 'Attach it to the transfer so the tip matches this share.',
                              });
                            }}
                          />
                        </View>
                      ) : null}
                      {IS_WEB ? (
                        <Button
                          title={`Pay ${myTip.chainAmount} USDC`}
                          icon={icon.near}
                          loading={busy === 'tip'}
                          disabled={busy === 'tip'}
                          onPress={() => void payTipNow(myTip)}
                        />
                      ) : (
                        <>
                          <Field
                            label="NEAR transaction hash"
                            hint="Copy it from your wallet right after the transfer. Globie only reads the chain."
                            value={tipHash}
                            onChangeText={setTipHash}
                            autoCapitalize="none"
                            autoCorrect={false}
                            spellCheck={false}
                            placeholder="2YbZa…"
                            returnKeyType="done"
                            onSubmitEditing={() => void settleTipNow(myTip.id)}
                          />
                          <Button
                            title="Confirm tip"
                            compact
                            icon={icon.check}
                            loading={busy === 'tip'}
                            disabled={tipHash.trim().length === 0 || busy === 'tip'}
                            onPress={() => void settleTipNow(myTip.id)}
                          />
                        </>
                      )}
                    </View>
                  ) : null}
                </>
              ) : myTip ? (
                <View style={styles.nearEntry}>
                  <View style={styles.rowBetween}>
                    <Text variant="body" style={styles.flex}>
                      {myTip.status === 'paid' ? 'You tipped' : 'Your tip is waiting'}
                    </Text>
                    <Text variant="mono">{money.format(myTip.amountMinor, currency)}</Text>
                  </View>
                  {myTip.status === 'paid' && myTip.settlementTxHash ? (
                    <TxReceipt txHash={myTip.settlementTxHash} />
                  ) : null}
                </View>
              ) : tips.data.canTip ? (
                <View style={styles.chips}>
                  {TIP_PRESETS.map((amountMinor) => (
                    <Button
                      key={amountMinor}
                      compact
                      variant="secondary"
                      icon={icon.hand}
                      title={formatMinor(amountMinor, currency)}
                      accessibilityLabel={`Tip ${formatMinor(amountMinor, currency)}`}
                      onPress={() => tipFronter(amountMinor)}
                      disabled={busy === 'tip'}
                    />
                  ))}
                </View>
              ) : (
                <Text variant="caption" tone="muted">
                  {tips.data.frontedBy === me?.id
                    ? 'You fronted this bill — the tips land with you.'
                    : 'Tips are closed for this bill.'}
                </Text>
              )}

              {paidTips.map((tip) => (
                <View key={tip.id} style={styles.nearEntry}>
                  <View style={styles.rowBetween}>
                    <Text variant="caption" style={styles.flex}>
                      {tip.fromMemberName}
                      {tip.message ? ` — ${tip.message}` : ''}
                    </Text>
                    <Text variant="mono">{money.format(tip.amountMinor, currency)}</Text>
                  </View>
                  {tip.settlementTxHash ? <TxReceipt txHash={tip.settlementTxHash} /> : null}
                </View>
              ))}

              {tips.data.totalMinor > 0 ? (
                <Text variant="caption" tone="accent">
                  {money.format(tips.data.totalMinor, currency)} tipped so far
                </Text>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  amount: { alignItems: 'flex-end' },
  amountNote: { textAlign: 'right' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  badgeDone: { borderColor: colors.accentText },
  section: { gap: space.md },
  itemCard: { gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  draftLine: { gap: space.sm },
  draftNumbers: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  exportRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  claimBlock: { gap: space.xs },
  claimRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  claimValue: { minWidth: 56, alignItems: 'center' },
  nearList: { gap: space.sm },
  nearEntry: { gap: space.xs },
  nearActions: { alignItems: 'flex-end', gap: space.xs },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
