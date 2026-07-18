const fs = require("fs");
const path = require("path");
const { BrowserController, sleep } = require("./browser");
const {
  ensureReviewPage,
  clickRefreshIfPresent,
  getCandidates,
  openEditModal,
  getDuplicateCreditBlock,
  waitForDuplicateCreditBlock,
  fillAndMaybeSubmitModal,
  fillAndMaybeResolveAmountMismatch,
  approveReviewTransaction,
  closeModalIfOpen,
  removeFromReviewList
} = require("./pageActions");
const { APP_VERSION, DATA_DIR, ensureDataDir, saveConfig } = require("./config");
const { HistoryStore } = require("./historyStore");
const { TelegramClient } = require("./telegram");

class TransactionWorker {
  constructor(config) {
    ensureDataDir();
    this.config = config;
    this.browser = new BrowserController(config);
    this.running = false;
    this.inCycle = false;
    this.timer = null;
    this.recentEvents = [];
    this.latestCandidates = [];
    this.lastCycleAt = null;
    this.nextCycleAt = null;
    this.lastError = null;
    this.currentReviewUrlIndex = 0;
    this.currentReviewUrl = this.getReviewUrls()[0] || this.config.reviewUrl;
    this.rangeSkipKeys = new Set();
    this.siteStatusBlockedKeys = new Set();
    this.telegramSkipKeys = new Set();
    this.processedPath = path.join(DATA_DIR, "processed.json");
    this.eventsPath = path.join(DATA_DIR, "events.jsonl");
    this.processed = this.loadProcessed();
    this.history = new HistoryStore(DATA_DIR, this.processed, this.eventsPath);
    this.telegram = new TelegramClient(DATA_DIR, this.config);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log("worker_started", { dryRun: this.config.dryRun });
    this.schedule(100);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCycleAt = null;
    this.log("worker_stopped", {});
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextCycleAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(async () => {
      await this.runOnce();
      this.schedule(this.config.checkIntervalMs);
    }, delayMs);
  }

  async runOnce() {
    if (this.inCycle) return { skipped: true, reason: "cycle already running" };
    this.inCycle = true;
    this.lastCycleAt = new Date().toISOString();
    this.lastError = null;

    try {
      const page = await this.browser.getPage();
      const reviewUrl = this.nextReviewUrl();
      this.currentReviewUrl = reviewUrl;
      await ensureReviewPage(page, reviewUrl);
      await this.processTelegramReplies(page);
      const openDuplicateBlock = await getDuplicateCreditBlock(page);
      if (openDuplicateBlock.blocked) {
        const duplicateRef = openDuplicateBlock.ref;
        await closeModalIfOpen(page);
        if (!duplicateRef) {
          throw new Error("Duplicate warning was open, but its transaction reference was unavailable");
        }
        if (this.config.dryRun) {
          this.log("dry_run_duplicate_credit_block", openDuplicateBlock);
        } else {
          page.acceptDialogsFor(15000);
          const removal = await removeFromReviewList(page, duplicateRef);
          this.processed[duplicateRef] = {
            removedFromReviewAt: new Date().toISOString(),
            gatewayTransactionId: openDuplicateBlock.gatewayTransactionId,
            duplicateBlockMessage: openDuplicateBlock.message,
            usedByTransactionId: openDuplicateBlock.usedByTransactionId,
            candidateType: "wrong_amount"
          };
          this.saveProcessed();
          this.log("duplicate_credit_removed_from_review", {
            ...removal,
            gatewayTransactionId: openDuplicateBlock.gatewayTransactionId,
            usedByTransactionId: openDuplicateBlock.usedByTransactionId
          });
        }
      }
      const refreshedBeforeScan = await clickRefreshIfPresent(page);
      this.log("refresh_before_scan", { clicked: refreshedBeforeScan });

      const candidates = await getCandidates(page, this.config);
      for (const candidate of candidates) {
        candidate.reviewUrl = reviewUrl;
        if (candidate.candidateType === "balance_mismatch") {
          candidate.telegramFollowup = this.telegram.getFollowupStatus(candidate.ref);
        }
      }
      this.latestCandidates = candidates;
      this.history.captureCandidates(candidates);
      this.log("scan_complete", { candidates: candidates.length, reviewUrl });

      let processedThisCycle = 0;
      for (const candidate of candidates) {
        if (processedThisCycle >= this.config.maxItemsPerCycle) break;
        const processedRecord = this.processed[candidate.ref];
        if (processedRecord) {
          if (this.config.dryRun) {
            this.log("dry_run_processed_row_not_removed", { ref: candidate.ref });
          } else {
            try {
              page.acceptDialogsFor(15000);
              const removal = await removeFromReviewList(page, candidate.ref);
              processedRecord.removedFromReviewAt = new Date().toISOString();
              this.saveProcessed();
              this.log("processed_row_removed_from_review", removal);
            } catch (error) {
              this.log("candidate_error", {
                ref: candidate.ref,
                error: error.message
              });
            }
          }
          processedThisCycle += 1;
          await sleep(1000);
          continue;
        }

        if (candidate.cleanupOnly || candidate.candidateType === "processed_status") {
          if (this.config.dryRun) {
            this.log("dry_run_processed_status_row_not_removed", {
              ref: candidate.ref,
              status: candidate.status,
              cleanupReason: candidate.cleanupReason
            });
          } else {
            try {
              page.acceptDialogsFor(15000);
              const removal = await removeFromReviewList(page, candidate.ref);
              this.processed[candidate.ref] = {
                removedFromReviewAt: new Date().toISOString(),
                cleanupReason: candidate.cleanupReason || "Processed status",
                status: candidate.status,
                gatewayTransactionId: candidate.gatewayTransactionId,
                merchantName: candidate.merchantName,
                candidateType: candidate.candidateType,
                originalCustomerPhone: candidate.originalCustomerPhone,
                correctCustomerPhone: candidate.correctCustomerPhone,
                correctedAmount: candidate.apiStatementAmount
              };
              this.saveProcessed();
              this.log("processed_status_row_removed_from_review", {
                ...removal,
                status: candidate.status,
                cleanupReason: candidate.cleanupReason || "Processed status"
              });
            } catch (error) {
              this.log("candidate_error", {
                ref: candidate.ref,
                error: error.message
              });
            }
          }
          processedThisCycle += 1;
          await sleep(1000);
          continue;
        }

        if (candidate.candidateType === "balance_mismatch") {
          await this.handleBalanceMismatch(candidate);
          processedThisCycle += 1;
          await sleep(500);
          continue;
        }

        if (candidate.candidateType === "manual_approval" && (!candidate.manualDataComplete || !candidate.phoneMatches)) {
          const skipKey = `${candidate.ref}:manual-phone:${candidate.originalCustomerPhone}:${candidate.correctCustomerPhone}`;
          if (!this.rangeSkipKeys.has(skipKey)) {
            this.rangeSkipKeys.add(skipKey);
            this.log("manual_approval_skipped_phone_check", {
              ref: candidate.ref,
              originalCustomerPhone: candidate.originalCustomerPhone,
              correctCustomerPhone: candidate.correctCustomerPhone,
              manualDataComplete: candidate.manualDataComplete,
              phoneMatches: candidate.phoneMatches
            });
          }
          continue;
        }

        const amount = Number(candidate.apiStatementAmount);
        const minAmount = Number(this.config.minAmount);
        const maxAmount = Number(this.config.maxAmount);
        if (amount < minAmount || (maxAmount > 0 && amount > maxAmount)) {
          const skipKey = `${candidate.ref}:${minAmount}:${maxAmount}`;
          if (!this.rangeSkipKeys.has(skipKey)) {
            this.rangeSkipKeys.add(skipKey);
            this.log("candidate_skipped_outside_amount_range", {
              ref: candidate.ref,
              candidateType: candidate.candidateType,
              correctedAmount: amount,
              minAmount,
              maxAmount,
              correctCustomerPhone: candidate.correctCustomerPhone
            });
          }
          continue;
        }

        if (this.siteStatusBlockedKeys.has(`${candidate.ref}:${candidate.status}`)) {
          continue;
        }

        try {
          try {
            await openEditModal(page, candidate.ref);
          } catch (openError) {
            const editTimedOut = /Timed out waiting for edit modal/i.test(openError.message);
            const resolverStatusAllowed = /missing|pending/i.test(candidate.status);
            if (candidate.candidateType === "wrong_amount" && editTimedOut && !resolverStatusAllowed) {
              const blockedKey = `${candidate.ref}:${candidate.status}`;
              if (!this.siteStatusBlockedKeys.has(blockedKey)) {
                this.siteStatusBlockedKeys.add(blockedKey);
                this.log("amount_correction_blocked_by_site_status", {
                  ref: candidate.ref,
                  status: candidate.status,
                  correctedAmount: candidate.apiStatementAmount,
                  error: "Edit did not open; the website Amount resolver only accepts Missing or Pending transactions"
                });
              }
              continue;
            }
            const canUseAmountResolver = candidate.candidateType === "wrong_amount"
              && editTimedOut
              && resolverStatusAllowed;
            if (!canUseAmountResolver) throw openError;

            await closeModalIfOpen(page).catch(() => {});
            if (!this.config.dryRun) page.acceptDialogsFor(30000);
            const resolution = await fillAndMaybeResolveAmountMismatch(page, candidate, this.config.dryRun);
            if (this.config.dryRun) {
              await closeModalIfOpen(page);
              this.log("dry_run_amount_resolver_ready", resolution);
            } else {
              this.processed[candidate.ref] = {
                submittedAt: new Date().toISOString(),
                correctedAmount: candidate.apiStatementAmount,
                gatewayTransactionId: candidate.gatewayTransactionId,
                customerPhone: candidate.customerPhone,
                originalCustomerPhone: candidate.originalCustomerPhone,
                correctCustomerPhone: candidate.correctCustomerPhone,
                candidateType: candidate.candidateType,
                merchantName: candidate.merchantName,
                resolutionMode: resolution.resolutionMode,
                vendorId: resolution.vendorId
              };
              this.saveProcessed();
              this.log("amount_mismatch_resolved", resolution);
            }
            processedThisCycle += 1;
            await sleep(1000);
            continue;
          }

          const duplicateBlock = await getDuplicateCreditBlock(page);
          if (duplicateBlock.blocked) {
            if (this.config.dryRun) {
              await closeModalIfOpen(page);
              this.log("dry_run_duplicate_credit_block", {
                ref: candidate.ref,
                ...duplicateBlock
              });
            } else {
              await closeModalIfOpen(page);
              page.acceptDialogsFor(15000);
              const removal = await removeFromReviewList(page, candidate.ref);
              this.processed[candidate.ref] = {
                removedFromReviewAt: new Date().toISOString(),
                correctedAmount: candidate.apiStatementAmount,
                gatewayTransactionId: candidate.gatewayTransactionId,
                merchantName: candidate.merchantName,
                candidateType: candidate.candidateType,
                originalCustomerPhone: candidate.originalCustomerPhone,
                correctCustomerPhone: candidate.correctCustomerPhone,
                duplicateBlockMessage: duplicateBlock.message,
                usedByTransactionId: duplicateBlock.usedByTransactionId
              };
              this.saveProcessed();
              this.log("duplicate_credit_removed_from_review", {
                ...removal,
                gatewayTransactionId: duplicateBlock.gatewayTransactionId || candidate.gatewayTransactionId,
                usedByTransactionId: duplicateBlock.usedByTransactionId
              });
            }
            processedThisCycle += 1;
            await sleep(1000);
            continue;
          }

          if (!this.config.dryRun) page.acceptDialogsFor(10000);
          const result = await fillAndMaybeSubmitModal(page, candidate, this.config.dryRun);
          if (this.config.dryRun) {
            await sleep(this.config.postSubmitWaitMs);
          }

          const postClickDuplicateBlock = this.config.dryRun
            ? { blocked: false }
            : await waitForDuplicateCreditBlock(page);
          if (!this.config.dryRun && postClickDuplicateBlock.blocked) {
            await closeModalIfOpen(page);
            page.acceptDialogsFor(15000);
            const removal = await removeFromReviewList(page, candidate.ref);
            this.processed[candidate.ref] = {
              removedFromReviewAt: new Date().toISOString(),
              correctedAmount: candidate.apiStatementAmount,
              gatewayTransactionId: candidate.gatewayTransactionId,
              merchantName: candidate.merchantName,
              candidateType: candidate.candidateType,
              originalCustomerPhone: candidate.originalCustomerPhone,
              correctCustomerPhone: candidate.correctCustomerPhone,
              duplicateBlockMessage: postClickDuplicateBlock.message,
              usedByTransactionId: postClickDuplicateBlock.usedByTransactionId
            };
            this.saveProcessed();
            this.log("duplicate_credit_removed_from_review", {
              ...removal,
              gatewayTransactionId: postClickDuplicateBlock.gatewayTransactionId || candidate.gatewayTransactionId,
              usedByTransactionId: postClickDuplicateBlock.usedByTransactionId
            });
            processedThisCycle += 1;
            await sleep(1000);
            continue;
          }

          if (this.config.dryRun) {
            await closeModalIfOpen(page);
            this.log("dry_run_ready", result);
          } else {
            this.processed[candidate.ref] = {
              submittedAt: new Date().toISOString(),
              correctedAmount: candidate.apiStatementAmount,
              gatewayTransactionId: candidate.gatewayTransactionId,
              customerPhone: result.customerPhone,
              originalCustomerPhone: result.originalCustomerPhone,
              correctCustomerPhone: result.correctCustomerPhone,
              candidateType: candidate.candidateType,
              merchantName: candidate.merchantName
            };
            this.saveProcessed();
            await closeModalIfOpen(page);
            this.log("make_up_deposit_clicked", result);
          }

          processedThisCycle += 1;
          await sleep(1000);
        } catch (error) {
          await closeModalIfOpen(page).catch(() => {});
          this.log("candidate_error", {
            ref: candidate.ref,
            error: error.message
          });
        }
      }

      const refreshedAfterCycle = await clickRefreshIfPresent(page);
      this.log("refresh_after_cycle", { clicked: refreshedAfterCycle });

      return { candidates: candidates.length, processed: processedThisCycle };
    } catch (error) {
      this.lastError = error.message;
      this.log("cycle_error", { error: error.message });
      return { error: error.message };
    } finally {
      this.inCycle = false;
    }
  }

  setDryRun(dryRun) {
    this.config.dryRun = Boolean(dryRun);
    saveConfig(this.config);
    this.log("mode_changed", { dryRun: this.config.dryRun });
  }

  getReviewUrls() {
    const urls = Array.isArray(this.config.reviewUrls)
      ? this.config.reviewUrls
      : String(this.config.reviewUrl || "").split(/\r?\n/);
    const cleanUrls = urls.map((url) => String(url || "").trim()).filter(Boolean);
    return cleanUrls.length ? cleanUrls : [this.config.reviewUrl];
  }

  nextReviewUrl() {
    const urls = this.getReviewUrls();
    const index = this.currentReviewUrlIndex % urls.length;
    const reviewUrl = urls[index];
    this.currentReviewUrlIndex = (index + 1) % urls.length;
    return reviewUrl;
  }

  updateConfig(patch) {
    if (Array.isArray(patch.reviewUrls) || typeof patch.reviewUrls === "string") {
      const raw = Array.isArray(patch.reviewUrls) ? patch.reviewUrls : String(patch.reviewUrls || "").split(/\r?\n/);
      const reviewUrls = raw.map((url) => String(url || "").trim()).filter(Boolean);
      if (reviewUrls.length) {
        this.config.reviewUrls = reviewUrls.filter((url, index, list) => list.indexOf(url) === index);
        this.config.reviewUrl = this.config.reviewUrls[0];
        this.currentReviewUrlIndex = 0;
        this.currentReviewUrl = this.config.reviewUrl;
        this.browser.config = this.config;
      }
    }
    if (Number.isFinite(Number(patch.checkIntervalMs))) {
      this.config.checkIntervalMs = Math.max(5000, Number(patch.checkIntervalMs));
    }
    if (Number.isFinite(Number(patch.dashboardRefreshMs))) {
      this.config.dashboardRefreshMs = Math.max(0, Number(patch.dashboardRefreshMs));
    }
    if (typeof patch.dateScope === "string" && ["all", "today", "week", "month"].includes(patch.dateScope)) {
      this.config.dateScope = patch.dateScope;
    }
    if (Number.isFinite(Number(patch.maxItemsPerCycle))) {
      this.config.maxItemsPerCycle = Math.max(1, Number(patch.maxItemsPerCycle));
    }
    if (Number.isFinite(Number(patch.minAmount))) {
      this.config.minAmount = Math.max(0, Number(patch.minAmount));
    }
    if (Number.isFinite(Number(patch.maxAmount))) {
      this.config.maxAmount = Math.max(0, Number(patch.maxAmount));
    }
    if (typeof patch.enableWrongAmount === "boolean") {
      this.config.enableWrongAmount = patch.enableWrongAmount;
    }
    if (typeof patch.enableWrongPhone === "boolean") {
      this.config.enableWrongPhone = patch.enableWrongPhone;
    }
    if (typeof patch.enableManualApproval === "boolean") {
      this.config.enableManualApproval = patch.enableManualApproval;
    }
    if (typeof patch.enableBalanceMismatch === "boolean") {
      this.config.enableBalanceMismatch = patch.enableBalanceMismatch;
    }
    if (typeof patch.enableTelegramFollowup === "boolean") {
      this.config.enableTelegramFollowup = patch.enableTelegramFollowup;
    }
    if (typeof patch.telegramBotToken === "string") {
      this.config.telegramBotToken = patch.telegramBotToken.trim();
      this.telegram.config = this.config;
    }
    this.rangeSkipKeys.clear();
    saveConfig(this.config);
    this.log("config_updated", {
      checkIntervalMs: this.config.checkIntervalMs,
      dashboardRefreshMs: this.config.dashboardRefreshMs,
      dateScope: this.config.dateScope,
      reviewUrl: this.config.reviewUrl,
      reviewUrls: this.getReviewUrls(),
      maxItemsPerCycle: this.config.maxItemsPerCycle,
      minAmount: this.config.minAmount,
      maxAmount: this.config.maxAmount,
      enableWrongAmount: this.config.enableWrongAmount,
      enableWrongPhone: this.config.enableWrongPhone,
      enableManualApproval: this.config.enableManualApproval,
      enableBalanceMismatch: this.config.enableBalanceMismatch,
      enableTelegramFollowup: this.config.enableTelegramFollowup,
      telegramHasToken: Boolean(this.config.telegramBotToken)
    });
  }

  getStatus() {
    return {
      running: this.running,
      appVersion: APP_VERSION,
      inCycle: this.inCycle,
      dryRun: this.config.dryRun,
      reviewUrl: this.config.reviewUrl,
      reviewUrls: this.getReviewUrls(),
      currentReviewUrl: this.currentReviewUrl,
      checkIntervalMs: this.config.checkIntervalMs,
      dashboardRefreshMs: this.config.dashboardRefreshMs,
      dateScope: this.config.dateScope,
      maxItemsPerCycle: this.config.maxItemsPerCycle,
      minAmount: this.config.minAmount,
      maxAmount: this.config.maxAmount,
      enableWrongAmount: this.config.enableWrongAmount,
      enableWrongPhone: this.config.enableWrongPhone,
      enableManualApproval: this.config.enableManualApproval,
      enableBalanceMismatch: this.config.enableBalanceMismatch,
      enableTelegramFollowup: this.config.enableTelegramFollowup,
      telegramHasToken: Boolean(this.config.telegramBotToken),
      telegram: this.telegram.getStatus(),
      lastCycleAt: this.lastCycleAt,
      nextCycleAt: this.nextCycleAt,
      lastError: this.lastError,
      latestCandidates: this.latestCandidates.slice(0, 50),
      processedCount: Object.keys(this.processed).length,
      historyCount: this.history.count,
      recentEvents: this.recentEvents.slice(0, 100)
    };
  }

  searchHistory(query, limit) {
    return this.history.search(query, limit);
  }

  getChatIds() {
    return this.telegram.listChatIds();
  }

  importChatIds(text) {
    const result = this.telegram.importChatIds(text);
    this.log("telegram_chat_ids_imported", result);
    return result;
  }

  setChatId(agentName, chatId) {
    const result = this.telegram.setChatId(agentName, chatId);
    this.log("telegram_chat_id_saved", result);
    return result;
  }

  deleteChatId(agentName) {
    const result = this.telegram.deleteChatId(agentName);
    this.log("telegram_chat_id_deleted", result);
    return result;
  }

  async handleBalanceMismatch(candidate) {
    if (!this.config.enableTelegramFollowup) {
      const skipKey = `${candidate.ref}:telegram-disabled`;
      if (!this.telegramSkipKeys.has(skipKey)) {
        this.telegramSkipKeys.add(skipKey);
        this.log("balance_mismatch_telegram_disabled", {
          ref: candidate.ref,
          agentName: candidate.agentName,
          agentKey: candidate.agentKey,
          gatewayTransactionId: candidate.gatewayTransactionId
        });
      }
      return;
    }

    if (!this.telegram.hasToken()) {
      const skipKey = `${candidate.ref}:telegram-token`;
      if (!this.telegramSkipKeys.has(skipKey)) {
        this.telegramSkipKeys.add(skipKey);
        this.log("balance_mismatch_telegram_token_missing", {
          ref: candidate.ref,
          agentName: candidate.agentName,
          agentKey: candidate.agentKey,
          gatewayTransactionId: candidate.gatewayTransactionId
        });
      }
      return;
    }

    try {
      const result = await this.telegram.sendBalanceFollowup(candidate);
      const detail = {
        ref: candidate.ref,
        agentName: candidate.agentName,
        agentKey: candidate.agentKey,
        reviewUrl: candidate.reviewUrl,
        gatewayTransactionId: candidate.gatewayTransactionId,
        amount: candidate.transactionAmount,
        customerPhone: candidate.customerPhone,
        walletBalance: candidate.walletBalance,
        smsCurrentBalance: candidate.smsCurrentBalance,
        sent: result.sent,
        reason: result.reason
      };
      if (result.sent) {
        this.log("balance_mismatch_telegram_sent", detail);
      } else {
        const skipKey = `${candidate.ref}:telegram-not-sent:${result.reason}`;
        if (!this.telegramSkipKeys.has(skipKey)) {
          this.telegramSkipKeys.add(skipKey);
          this.log("balance_mismatch_telegram_not_sent", detail);
        }
      }
    } catch (error) {
      this.log("candidate_error", {
        ref: candidate.ref,
        error: `Telegram send failed: ${error.message}`
      });
    }
  }

  async processTelegramReplies(page) {
    if (!this.config.enableTelegramFollowup || !this.telegram.hasToken()) return;
    const previousUpdateId = this.config.telegramLastUpdateId;
    let commands = [];
    try {
      commands = await this.telegram.pollReplies();
      if (this.config.telegramLastUpdateId !== previousUpdateId) saveConfig(this.config);
    } catch (error) {
      this.log("telegram_poll_error", { error: error.message });
      return;
    }

    for (const command of commands) {
      const statusText = command.action === "yes" ? "Yes Received" : "Not Received";
      await this.telegram.acknowledge(command.callbackQueryId, statusText);
      const instantMessageUpdate = await this.telegram.updateFollowupMessage(command, statusText)
        .catch((error) => ({ updated: false, error: error.message }));
      this.telegram.markDone(command.ref, command.action, { confirmedBy: command.confirmedBy });
      this.log("balance_mismatch_telegram_confirmed", {
        ref: command.ref,
        reviewUrl: command.reviewUrl,
        telegramAction: command.action === "yes" ? "yes_received" : "not_received",
        confirmedBy: command.confirmedBy,
        telegramMessageUpdated: instantMessageUpdate.updated,
        telegramMessageUpdateError: instantMessageUpdate.error
      });

      if (this.config.dryRun) {
        this.log("dry_run_telegram_response_ready", {
          ref: command.ref,
          action: command.action
        });
        continue;
      }

      try {
        if (command.reviewUrl) {
          await ensureReviewPage(page, command.reviewUrl);
          await clickRefreshIfPresent(page).catch(() => {});
        }
        if (command.action === "yes") {
          page.acceptDialogsFor(15000);
          let candidate = this.latestCandidates.find((item) => item.ref === command.ref);
          if (!candidate && command.reviewUrl) {
            const pageCandidates = await getCandidates(page, this.config);
            candidate = pageCandidates.find((item) => item.ref === command.ref);
            if (candidate) candidate.reviewUrl = command.reviewUrl;
          }
          if (candidate?.candidateType === "balance_mismatch" && candidate.balanceMismatchPhoneIssue) {
            if (!candidate.manualDataComplete || !candidate.correctCustomerPhone || candidate.correctCustomerPhone === candidate.originalCustomerPhone) {
              this.log("balance_mismatch_phone_fix_required", {
                ref: command.ref,
                customerPhone: candidate.customerPhone,
                originalCustomerPhone: candidate.originalCustomerPhone,
                correctCustomerPhone: candidate.correctCustomerPhone,
                smsPhoneRaw: candidate.smsPhoneRaw,
                confirmedBy: command.confirmedBy,
                error: "SMS phone is masked or unavailable, so the checker cannot safely auto-correct before approval"
              });
              continue;
            }

            await openEditModal(page, command.ref);
            const fixResult = await fillAndMaybeSubmitModal(page, {
              ...candidate,
              candidateType: "balance_mismatch_phone_fix"
            }, false);
            this.processed[command.ref] = {
              submittedAt: new Date().toISOString(),
              candidateType: "balance_mismatch_phone_fix",
              telegramAction: "yes_received",
              confirmedBy: command.confirmedBy,
              correctedAmount: candidate.apiStatementAmount,
              gatewayTransactionId: candidate.gatewayTransactionId,
              customerPhone: fixResult.customerPhone,
              originalCustomerPhone: fixResult.originalCustomerPhone,
              correctCustomerPhone: fixResult.correctCustomerPhone,
              phoneCorrectedBeforeApproval: true
            };
            this.saveProcessed();
            await closeModalIfOpen(page).catch(() => {});
            this.telegram.markDone(command.ref, "approved", { confirmedBy: command.confirmedBy });
            this.log("balance_mismatch_phone_corrected_before_approval", {
              ...fixResult,
              confirmedBy: command.confirmedBy,
              smsPhoneRaw: candidate.smsPhoneRaw
            });
            continue;
          }

          const approval = await approveReviewTransaction(page, command.ref);
          this.processed[command.ref] = {
            submittedAt: new Date().toISOString(),
            candidateType: "balance_mismatch",
            telegramAction: "yes_received",
            confirmedBy: command.confirmedBy,
            approvedFromReviewList: true
          };
          this.saveProcessed();
          this.telegram.markDone(command.ref, "approved", { confirmedBy: command.confirmedBy });
          this.log("balance_mismatch_telegram_approved", {
            ...approval,
            confirmedBy: command.confirmedBy
          });
        } else {
          page.acceptDialogsFor(15000);
          const removal = await removeFromReviewList(page, command.ref);
          this.processed[command.ref] = {
            removedFromReviewAt: new Date().toISOString(),
            candidateType: "balance_mismatch",
            telegramAction: "not_received",
            confirmedBy: command.confirmedBy,
            removedFromReviewList: true
          };
          this.saveProcessed();
          this.telegram.markDone(command.ref, "removed", { confirmedBy: command.confirmedBy });
          this.log("balance_mismatch_telegram_removed", {
            ...removal,
            confirmedBy: command.confirmedBy
          });
        }
      } catch (error) {
        await closeModalIfOpen(page).catch(() => {});
        this.log("candidate_error", {
          ref: command.ref,
          error: `Telegram response action failed: ${error.message}`
        });
      }
    }
  }

  loadProcessed() {
    if (!fs.existsSync(this.processedPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.processedPath, "utf8"));
    } catch {
      return {};
    }
  }

  saveProcessed() {
    fs.writeFileSync(this.processedPath, JSON.stringify(this.processed, null, 2));
  }

  log(type, detail) {
    const event = {
      at: new Date().toISOString(),
      type,
      detail
    };
    this.recentEvents.unshift(event);
    this.recentEvents = this.recentEvents.slice(0, 200);
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    const candidate = detail?.ref
      ? this.latestCandidates.find((item) => item.ref === detail.ref)
      : null;
    this.history.recordEvent(type, detail, candidate);
    console.log(`[${event.at}] ${type}`, detail || "");
  }
}

module.exports = {
  TransactionWorker
};
