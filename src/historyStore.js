const fs = require("fs");
const path = require("path");
const { normalizeAgentKey } = require("./agentKey");

const ACTION_LABELS = {
  make_up_deposit_clicked: "Make-up submitted",
  amount_mismatch_resolved: "Amount mismatch resolved",
  amount_correction_blocked_by_site_status: "Amount correction blocked by website status",
  processed_row_removed_from_review: "Processed row removed",
  processed_status_row_removed_from_review: "Processed status removed",
  balance_mismatch_telegram_sent: "Balance mismatch sent to Telegram",
  balance_mismatch_telegram_not_sent: "Balance mismatch not sent",
  balance_mismatch_telegram_confirmed: "Telegram confirmation received",
  balance_mismatch_telegram_disabled: "Telegram follow-up disabled",
  balance_mismatch_telegram_token_missing: "Telegram bot token missing",
  balance_mismatch_skipped_outside_amount_range: "Balance mismatch skipped outside range",
  balance_mismatch_telegram_approved: "Telegram confirmed received",
  balance_mismatch_telegram_removed: "Telegram confirmed not received",
  balance_mismatch_phone_fix_required: "Balance mismatch phone fix required",
  balance_mismatch_phone_corrected_before_approval: "Balance mismatch phone corrected",
  below_min_row_removed_from_review: "Below minimum removed",
  duplicate_credit_removed_from_review: "Duplicate blocked and removed",
  dry_run_ready: "Dry-run prepared",
  dry_run_amount_resolver_ready: "Amount resolver prepared",
  dry_run_processed_row_not_removed: "Processed row found (dry-run)",
  dry_run_processed_status_row_not_removed: "Processed status found (dry-run)",
  dry_run_telegram_response_ready: "Telegram response ready (dry-run)",
  dry_run_below_min_row_not_removed: "Below minimum found (dry-run)",
  dry_run_duplicate_credit_block: "Duplicate blocked (dry-run)",
  wrong_phone_skipped_outside_range: "Wrong phone skipped outside range",
  candidate_skipped_outside_amount_range: "Skipped outside amount range",
  manual_approval_skipped_phone_check: "Manual approval skipped - phone check failed",
  telegram_poll_error: "Telegram polling error",
  telegram_chat_ids_imported: "Telegram chat IDs imported",
  telegram_chat_id_saved: "Telegram chat ID saved",
  telegram_chat_id_deleted: "Telegram chat ID deleted",
  candidate_error: "Error - retrying"
};

const ACTION_DETAIL_KEYS = [
  "ref",
  "reviewUrl",
  "originalAmount",
  "correctedAmount",
  "amount",
  "minAmount",
  "maxAmount",
  "minCorrectAmount",
  "customerPhone",
  "originalCustomerPhone",
  "correctCustomerPhone",
  "correctPhoneSource",
  "candidateType",
  "telegramAction",
  "status",
  "updatedText",
  "updatedAt",
  "manualDataComplete",
  "phoneMatches",
  "smsPhoneRaw",
  "balanceMismatchPhoneIssue",
  "phoneCorrectedBeforeApproval",
  "cleanupReason",
  "merchantName",
  "agentName",
  "agentKey",
  "chatId",
  "deleted",
  "imported",
  "skipped",
  "confirmedBy",
  "telegramMessageUpdated",
  "telegramMessageUpdateError",
  "merchantOption",
  "gatewayTransactionId",
  "walletBalance",
  "smsCurrentBalance",
  "vendorId",
  "resolutionMode",
  "usedByTransactionId",
  "sent",
  "reason",
  "approvedFromReviewList",
  "removedFromReviewList",
  "submitted",
  "error"
];

class HistoryStore {
  constructor(dataDir, processed = {}, eventsPath = "") {
    this.historyPath = path.join(dataDir, "transactions.json");
    this.records = this.load();
    this.importProcessed(processed);
    this.importEvents(eventsPath);
    this.backfillAgentNames();
    this.save();
  }

  load() {
    if (!fs.existsSync(this.historyPath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  save() {
    fs.writeFileSync(this.historyPath, JSON.stringify(this.records, null, 2));
  }

  importProcessed(processed) {
    for (const [ref, item] of Object.entries(processed || {})) {
      const at = item.submittedAt || item.removedFromReviewAt || new Date().toISOString();
      const existing = this.records[ref] || { ref, firstSeenAt: at, actions: [] };
      this.records[ref] = {
        ...existing,
        ref,
        gatewayTransactionId: existing.gatewayTransactionId || item.gatewayTransactionId || "",
        vendorId: existing.vendorId || item.vendorId || "",
        resolutionMode: existing.resolutionMode || item.resolutionMode || "",
        merchantName: existing.merchantName || item.merchantName || "",
        customerPhone: existing.customerPhone || item.customerPhone || "",
        correctAmount: existing.correctAmount ?? item.correctedAmount ?? null,
        submittedAt: existing.submittedAt || item.submittedAt || "",
        removedFromReviewAt: existing.removedFromReviewAt || item.removedFromReviewAt || "",
        outcome: existing.outcome || (item.removedFromReviewAt ? "Removed from Txn Review" : "Make-up submitted"),
        lastUpdatedAt: latestDate(existing.lastUpdatedAt, at),
        actions: Array.isArray(existing.actions) ? existing.actions : []
      };
    }
  }

  importEvents(eventsPath) {
    if (!eventsPath || !fs.existsSync(eventsPath)) return;
    const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!event?.detail?.ref || !ACTION_LABELS[event.type]) continue;
        this.recordEvent(event.type, event.detail, null, event.at, false);
      } catch {
        // Ignore malformed legacy log lines; current records remain usable.
      }
    }
  }

  backfillAgentNames() {
    for (const record of Object.values(this.records)) {
      record.agentName = record.agentName || extractAgentName(record.walletText);
    }
  }

  captureCandidates(candidates) {
    const now = new Date().toISOString();
    for (const candidate of candidates || []) {
      this.mergeCandidate(candidate, now);
    }
    if ((candidates || []).length) this.save();
  }

  mergeCandidate(candidate, at = new Date().toISOString()) {
    if (!candidate?.ref) return null;
    const existing = this.records[candidate.ref] || {
      ref: candidate.ref,
      firstSeenAt: at,
      actions: []
    };
    const record = {
      ...existing,
      ref: candidate.ref,
      reviewUrl: candidate.reviewUrl || existing.reviewUrl || "",
      id: candidate.id || existing.id || "",
      merchantName: candidate.merchantName || existing.merchantName || "",
      walletText: candidate.walletText || existing.walletText || "",
      agentName: candidate.agentName || existing.agentName || extractAgentName(candidate.walletText || existing.walletText),
      agentKey: candidate.agentKey || existing.agentKey || normalizeAgentKey(candidate.agentName || existing.agentName || extractAgentName(candidate.walletText || existing.walletText)),
      gatewayTransactionId: candidate.gatewayTransactionId || existing.gatewayTransactionId || "",
      tableAmountText: candidate.tableAmountText || existing.tableAmountText || "",
      transactionAmount: candidate.transactionAmount ?? existing.transactionAmount ?? null,
      correctAmount: candidate.apiStatementAmount ?? existing.correctAmount ?? null,
      correctAmountSource: candidate.correctAmountSource || existing.correctAmountSource || "",
      customerPhone: candidate.customerPhone || existing.customerPhone || "",
      originalCustomerPhone: candidate.originalCustomerPhone || existing.originalCustomerPhone || candidate.customerPhone || "",
      correctCustomerPhone: candidate.correctCustomerPhone || existing.correctCustomerPhone || candidate.customerPhone || "",
      correctPhoneSource: candidate.correctPhoneSource || existing.correctPhoneSource || "",
      candidateType: candidate.candidateType || existing.candidateType || "wrong_amount",
      manualDataComplete: candidate.manualDataComplete ?? existing.manualDataComplete ?? true,
      phoneMatches: candidate.phoneMatches ?? existing.phoneMatches ?? true,
      smsPhoneRaw: candidate.smsPhoneRaw || existing.smsPhoneRaw || "",
      balanceMismatchPhoneIssue: candidate.balanceMismatchPhoneIssue ?? existing.balanceMismatchPhoneIssue ?? false,
      status: candidate.status || existing.status || "",
      updatedText: candidate.updatedText || existing.updatedText || "",
      updatedAt: candidate.updatedAt || existing.updatedAt || "",
      reasonBadge: candidate.reasonBadge || existing.reasonBadge || "",
      reasonText: candidate.reasonText || existing.reasonText || "",
      walletBalance: candidate.walletBalance ?? existing.walletBalance ?? null,
      smsCurrentBalance: candidate.smsCurrentBalance ?? existing.smsCurrentBalance ?? null,
      firstSeenAt: existing.firstSeenAt || at,
      lastSeenAt: at,
      lastUpdatedAt: at,
      outcome: existing.outcome || "Detected",
      actions: Array.isArray(existing.actions) ? existing.actions : []
    };
    this.records[candidate.ref] = record;
    return record;
  }

  recordEvent(type, detail, candidate = null, at = new Date().toISOString(), persist = true) {
    const ref = detail?.ref || candidate?.ref;
    if (!ref || !ACTION_LABELS[type]) return;
    const record = candidate
      ? this.mergeCandidate(candidate, at)
      : (this.records[ref] || { ref, firstSeenAt: at, actions: [] });
    const compactDetail = {};
    for (const key of ACTION_DETAIL_KEYS) {
      if (detail?.[key] !== undefined) compactDetail[key] = detail[key];
    }

    record.transactionAmount = record.transactionAmount ?? detail?.originalAmount ?? null;
    record.reviewUrl = record.reviewUrl || detail?.reviewUrl || "";
    record.correctAmount = record.correctAmount ?? detail?.correctedAmount ?? null;
    record.customerPhone = record.customerPhone || detail?.customerPhone || "";
    record.originalCustomerPhone = record.originalCustomerPhone || detail?.originalCustomerPhone || "";
    record.correctCustomerPhone = record.correctCustomerPhone || detail?.correctCustomerPhone || detail?.customerPhone || "";
    record.correctPhoneSource = record.correctPhoneSource || detail?.correctPhoneSource || "";
    record.candidateType = record.candidateType || detail?.candidateType || "";
    record.updatedText = record.updatedText || detail?.updatedText || "";
    record.updatedAt = record.updatedAt || detail?.updatedAt || "";
    if (detail?.manualDataComplete !== undefined) record.manualDataComplete = detail.manualDataComplete;
    if (detail?.phoneMatches !== undefined) record.phoneMatches = detail.phoneMatches;
    if (detail?.balanceMismatchPhoneIssue !== undefined) record.balanceMismatchPhoneIssue = detail.balanceMismatchPhoneIssue;
    record.smsPhoneRaw = record.smsPhoneRaw || detail?.smsPhoneRaw || "";
    record.merchantName = record.merchantName || detail?.merchantName || "";
    record.agentName = record.agentName || detail?.agentName || "";
    record.agentKey = record.agentKey || detail?.agentKey || normalizeAgentKey(record.agentName);
    record.merchantOption = record.merchantOption || detail?.merchantOption || "";
    record.gatewayTransactionId = record.gatewayTransactionId || detail?.gatewayTransactionId || "";
    record.walletBalance = record.walletBalance ?? detail?.walletBalance ?? null;
    record.smsCurrentBalance = record.smsCurrentBalance ?? detail?.smsCurrentBalance ?? null;
    record.vendorId = record.vendorId || detail?.vendorId || "";
    record.resolutionMode = record.resolutionMode || detail?.resolutionMode || "";
    record.usedByTransactionId = record.usedByTransactionId || detail?.usedByTransactionId || "";
    record.outcome = ACTION_LABELS[type];
    record.lastAction = type;
    record.lastUpdatedAt = latestDate(record.lastUpdatedAt, at);
    if (type === "make_up_deposit_clicked" || type === "amount_mismatch_resolved") record.submittedAt = record.submittedAt || at;
    if (/removed_from_review/.test(type)) record.removedFromReviewAt = record.removedFromReviewAt || at;
    if (type === "candidate_error") record.lastError = detail?.error || "Unknown error";

    const actions = Array.isArray(record.actions) ? record.actions : [];
    const compactJson = JSON.stringify(compactDetail);
    if (!actions.some((action) => action.type === type && JSON.stringify(action.detail || {}) === compactJson)) {
      actions.push({ at, type, label: ACTION_LABELS[type], detail: compactDetail });
    }
    record.actions = actions.slice(-100);
    this.records[ref] = record;
    if (persist) this.save();
  }

  search(query = "", limit = 100) {
    const needle = String(query || "").trim().toLowerCase();
    const all = Object.values(this.records);
    const filtered = needle ? all.filter((record) => searchableText(record).includes(needle)) : all;
    filtered.sort((a, b) => dateValue(b.lastUpdatedAt || b.lastSeenAt || b.firstSeenAt) - dateValue(a.lastUpdatedAt || a.lastSeenAt || a.firstSeenAt));
    return {
      query: String(query || ""),
      total: filtered.length,
      totalRecords: all.length,
      items: filtered.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
    };
  }

  get count() {
    return Object.keys(this.records).length;
  }
}

function searchableText(record) {
  return [
    record.ref,
    record.reviewUrl,
    record.id,
    record.gatewayTransactionId,
    record.merchantName,
    record.agentName,
    record.agentKey,
    record.merchantOption,
    record.walletText,
    record.customerPhone,
    record.originalCustomerPhone,
    record.correctCustomerPhone,
    record.smsPhoneRaw,
    record.correctPhoneSource,
    record.candidateType,
    record.status,
    record.updatedText,
    record.updatedAt,
    record.reasonBadge,
    record.reasonText,
    record.walletBalance,
    record.smsCurrentBalance,
    record.outcome,
    record.lastError,
    record.usedByTransactionId,
    record.vendorId,
    record.resolutionMode
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function latestDate(left, right) {
  return dateValue(left) >= dateValue(right) ? (left || right || "") : (right || left || "");
}

function dateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractAgentName(walletText) {
  const match = String(walletText || "").match(/\/\s*([^\s/]+)/);
  return match ? match[1].trim() : "";
}

module.exports = {
  HistoryStore
};
