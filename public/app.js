const els = {
  runState: document.querySelector("#runState"),
  modeState: document.querySelector("#modeState"),
  lastCycle: document.querySelector("#lastCycle"),
  nextCycle: document.querySelector("#nextCycle"),
  candidateCount: document.querySelector("#candidateCount"),
  processedCount: document.querySelector("#processedCount"),
  historyCount: document.querySelector("#historyCount"),
  candidateRows: document.querySelector("#candidateRows"),
  events: document.querySelector("#events"),
  errorText: document.querySelector("#errorText"),
  intervalInput: document.querySelector("#intervalInput"),
  reviewUrlsInput: document.querySelector("#reviewUrlsInput"),
  maxInput: document.querySelector("#maxInput"),
  amountMinInput: document.querySelector("#amountMinInput"),
  amountMaxInput: document.querySelector("#amountMaxInput"),
  dashboardRefreshInput: document.querySelector("#dashboardRefreshInput"),
  dateScopeInput: document.querySelector("#dateScopeInput"),
  enableWrongAmountInput: document.querySelector("#enableWrongAmountInput"),
  enableWrongPhoneInput: document.querySelector("#enableWrongPhoneInput"),
  enableManualApprovalInput: document.querySelector("#enableManualApprovalInput"),
  enableBalanceMismatchInput: document.querySelector("#enableBalanceMismatchInput"),
  enableTelegramFollowupInput: document.querySelector("#enableTelegramFollowupInput"),
  telegramTokenInput: document.querySelector("#telegramTokenInput"),
  saveTelegramBtn: document.querySelector("#saveTelegramBtn"),
  telegramStatus: document.querySelector("#telegramStatus"),
  chatImportInput: document.querySelector("#chatImportInput"),
  importChatIdsBtn: document.querySelector("#importChatIdsBtn"),
  chatImportFileInput: document.querySelector("#chatImportFileInput"),
  importChatIdFileBtn: document.querySelector("#importChatIdFileBtn"),
  chatIdList: document.querySelector("#chatIdList"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  runOnceBtn: document.querySelector("#runOnceBtn"),
  modeBtn: document.querySelector("#modeBtn"),
  saveConfigBtn: document.querySelector("#saveConfigBtn"),
  liveConfirm: document.querySelector("#liveConfirm"),
  liveConfirmInput: document.querySelector("#liveConfirmInput"),
  confirmLiveBtn: document.querySelector("#confirmLiveBtn"),
  cancelLiveBtn: document.querySelector("#cancelLiveBtn"),
  historySearch: document.querySelector("#historySearch"),
  historyResultCount: document.querySelector("#historyResultCount"),
  historyRows: document.querySelector("#historyRows"),
  historyDialog: document.querySelector("#historyDialog"),
  historyDialogTitle: document.querySelector("#historyDialogTitle"),
  historyDetails: document.querySelector("#historyDetails"),
  historyActions: document.querySelector("#historyActions"),
  closeHistoryDialog: document.querySelector("#closeHistoryDialog")
};

let currentStatus = null;
let offlineSince = null;
let historyItems = new Map();
let historySearchTimer = null;
let chatIdItems = [];
let editingChatAgentKey = "";
let dashboardReloadTimer = null;
let activeDashboardRefreshMs = null;

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function text(value) {
  return String(value == null ? "" : value);
}

function html(value) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatAmount(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : text(value);
}

function formatCandidateType(value) {
  if (value === "wrong_phone") return "Wrong phone number";
  if (value === "manual_approval") return "Manual approval required";
  if (value === "balance_mismatch") return "Balance mismatch";
  if (value === "processed_status") return "Processed status";
  return "Wrong amount";
}

async function post(url, body = {}) {
  setBusy(true);
  try {
    els.errorText.textContent = "";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed");
    render(payload.status || payload);
  } catch (error) {
    showOffline(error);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  [els.startBtn, els.stopBtn, els.runOnceBtn, els.modeBtn, els.saveConfigBtn, els.saveTelegramBtn, els.importChatIdsBtn, els.importChatIdFileBtn].forEach((button) => {
    button.disabled = isBusy;
  });
}

function render(status) {
  offlineSince = null;
  currentStatus = status;
  els.runState.textContent = status.running ? (status.inCycle ? "Scanning" : "Running") : "Stopped";
  els.runState.classList.remove("offline");
  els.runState.classList.toggle("running", status.running);
  els.modeState.textContent = status.dryRun ? "Dry-run" : "Live";
  els.modeState.classList.toggle("live", !status.dryRun);
  els.modeBtn.textContent = status.dryRun ? "Switch to live" : "Switch to dry-run";
  if (!status.dryRun) {
    hideLiveConfirm();
  }

  els.lastCycle.textContent = formatTime(status.lastCycleAt);
  els.nextCycle.textContent = formatTime(status.nextCycleAt);
  els.candidateCount.textContent = status.latestCandidates.length;
  els.processedCount.textContent = status.processedCount;
  els.historyCount.textContent = status.historyCount || 0;
  els.errorText.textContent = status.lastError || "";

  els.intervalInput.value = Math.round(status.checkIntervalMs / 1000);
  els.reviewUrlsInput.value = (status.reviewUrls && status.reviewUrls.length ? status.reviewUrls : [status.reviewUrl]).join("\n");
  if (status.currentReviewUrl) {
    document.querySelector("#subtitle").textContent = `Checking: ${status.currentReviewUrl}`;
  }
  els.maxInput.value = status.maxItemsPerCycle;
  els.amountMinInput.value = status.minAmount;
  els.amountMaxInput.value = status.maxAmount;
  els.dashboardRefreshInput.value = Math.round((status.dashboardRefreshMs || 0) / 60000);
  els.dateScopeInput.value = status.dateScope || "all";
  els.enableWrongAmountInput.checked = status.enableWrongAmount;
  els.enableWrongPhoneInput.checked = status.enableWrongPhone;
  els.enableManualApprovalInput.checked = status.enableManualApproval;
  els.enableBalanceMismatchInput.checked = status.enableBalanceMismatch;
  els.enableTelegramFollowupInput.checked = status.enableTelegramFollowup;
  els.telegramStatus.textContent = `TG ${status.telegramHasToken ? "token saved" : "token missing"} - ${status.telegram?.chatIdCount || 0} chat IDs - ${status.telegram?.pendingFollowups || 0} pending`;

  els.candidateRows.innerHTML = status.latestCandidates.map((item) => `
    <tr>
      <td>${html(item.ref)}</td>
      <td>${html(item.merchantName)}</td>
      <td>${html(item.agentName || "-")}</td>
      <td>${html(item.gatewayTransactionId)}</td>
      <td class="amount-bad">${html(item.transactionAmount)}</td>
      <td class="amount-good">${html(item.apiStatementAmount)}</td>
      <td>${html(item.customerPhone)}</td>
      <td>${html(formatCorrectPhone(item))}</td>
      <td>${html(formatTelegramStatus(item.telegramFollowup))}</td>
    </tr>
  `).join("") || `<tr><td colspan="9">No transaction review matches in the current scan.</td></tr>`;

  els.events.innerHTML = status.recentEvents.map((event) => `
    <div class="event">
      <strong>${html(event.type)} - ${html(formatTime(event.at))}</strong>
        <span>${html(JSON.stringify(event.detail || {}))}</span>
    </div>
  `).join("");

  scheduleDashboardReload(status.dashboardRefreshMs || 0);
}

function scheduleDashboardReload(refreshMs) {
  const normalized = Number(refreshMs) || 0;
  if (activeDashboardRefreshMs === normalized) return;
  activeDashboardRefreshMs = normalized;
  if (dashboardReloadTimer) clearTimeout(dashboardReloadTimer);
  dashboardReloadTimer = null;
  if (normalized > 0) {
    dashboardReloadTimer = setTimeout(() => {
      window.location.reload();
    }, normalized);
  }
}

function formatTelegramStatus(followup) {
  if (!followup || !followup.label) return "-";
  return followup.confirmedBy ? `${followup.label} by ${followup.confirmedBy}` : followup.label;
}

function formatCorrectPhone(item) {
  if (item.balanceMismatchPhoneIssue) {
    if (item.correctCustomerPhone && item.correctCustomerPhone !== item.originalCustomerPhone) {
      return `Wrong number -> ${item.correctCustomerPhone}`;
    }
    return item.smsPhoneRaw ? `Wrong number (${item.smsPhoneRaw})` : "Wrong number";
  }
  return item.correctCustomerPhone || item.customerPhone;
}

async function refreshChatIds() {
  try {
    const response = await fetch("/api/chat-ids");
    if (!response.ok) throw new Error(`Chat ID status ${response.status}`);
    const payload = await response.json();
    chatIdItems = payload.items || [];
    renderChatIds();
  } catch (error) {
    els.chatIdList.textContent = error.message;
  }
}

function renderChatIds() {
  els.chatIdList.innerHTML = `
    <table class="chat-id-table">
      <thead>
        <tr>
          <th>Agent Name</th>
          <th>Chat ID</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${chatIdItems.length ? chatIdItems.map((item) => `
          ${editingChatAgentKey === item.agentKey ? `
            <tr>
              <td><input class="chat-edit-input" data-chat-edit-agent type="text" value="${html(item.agentKey)}"></td>
              <td><input class="chat-edit-input" data-chat-edit-id type="text" value="${html(item.chatId)}"></td>
              <td class="chat-actions">
                <button class="mini-button" type="button" data-chat-save="${html(item.agentKey)}">Save</button>
                <button class="mini-button secondary" type="button" data-chat-cancel>Cancel</button>
              </td>
            </tr>
          ` : `
            <tr>
              <td>${html(item.agentKey)}</td>
              <td>${html(item.chatId)}</td>
              <td class="chat-actions">
                <button class="mini-button secondary" type="button" data-chat-edit="${html(item.agentKey)}">Edit</button>
                <button class="mini-button danger" type="button" data-chat-delete="${html(item.agentKey)}">Delete</button>
              </td>
            </tr>
          `}
        `).join("") : `<tr><td colspan="3">No chat IDs imported.</td></tr>`}
      </tbody>
    </table>
  `;
}

async function saveChatId(agentName, chatId) {
  setBusy(true);
  try {
    const response = await fetch("/api/chat-ids/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName, chatId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Save failed");
    chatIdItems = payload.items || [];
    editingChatAgentKey = "";
    render(payload.status);
    renderChatIds();
  } catch (error) {
    showOffline(error);
  } finally {
    setBusy(false);
  }
}

async function deleteChatId(agentName) {
  setBusy(true);
  try {
    const response = await fetch("/api/chat-ids/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Delete failed");
    chatIdItems = payload.items || [];
    editingChatAgentKey = "";
    render(payload.status);
    renderChatIds();
  } catch (error) {
    showOffline(error);
  } finally {
    setBusy(false);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function refreshHistory() {
  try {
    const query = els.historySearch.value.trim();
    const response = await fetch(`/api/history?q=${encodeURIComponent(query)}&limit=200`);
    if (!response.ok) throw new Error(`History status ${response.status}`);
    renderHistory(await response.json());
  } catch (error) {
    els.historyRows.innerHTML = `<tr><td colspan="12">${html(error.message)}</td></tr>`;
  }
}

function renderHistory(payload) {
  historyItems = new Map(payload.items.map((item) => [item.ref, item]));
  els.historyResultCount.textContent = `${payload.total.toLocaleString()} of ${payload.totalRecords.toLocaleString()} records`;
  els.historyRows.innerHTML = payload.items.map((item) => `
    <tr>
      <td class="history-ref">${html(item.ref)}</td>
      <td>${html(item.gatewayTransactionId || "-")}</td>
      <td>${html(item.merchantName || "-")}</td>
      <td>${html(item.agentName || "-")}</td>
      <td class="amount-bad">${html(formatAmount(item.transactionAmount))}</td>
      <td class="amount-good">${html(formatAmount(item.correctAmount))}</td>
      <td>${html(item.customerPhone || "-")}</td>
      <td>${html(item.correctCustomerPhone || item.customerPhone || "-")}</td>
      <td>${html(item.status || "-")}</td>
      <td>${html(item.outcome || "Detected")}</td>
      <td>${html(formatTime(item.lastUpdatedAt || item.lastSeenAt || item.firstSeenAt))}</td>
      <td><button class="detail-button secondary" type="button" data-history-ref="${html(item.ref)}">Details</button></td>
    </tr>
  `).join("") || `<tr><td colspan="12">No archived transactions match this search.</td></tr>`;
}

function openHistoryDetails(ref) {
  const item = historyItems.get(ref);
  if (!item) return;
  els.historyDialogTitle.textContent = item.ref;
  const fields = [
    ["Reference", item.ref],
    ["Internal ID", item.id],
    ["Gateway / SMS", item.gatewayTransactionId],
    ["Merchant", item.merchantName],
    ["Agent", item.agentName],
    ["Merchant option", item.merchantOption],
    ["Wallet", item.walletText],
    ["Original amount", formatAmount(item.transactionAmount)],
    ["Correct amount", formatAmount(item.correctAmount)],
    ["Correct source", item.correctAmountSource],
    ["Candidate type", formatCandidateType(item.candidateType)],
    ["Original phone", item.originalCustomerPhone || item.customerPhone],
    ["Correct phone", item.correctCustomerPhone || item.customerPhone],
    ["SMS phone", item.smsPhoneRaw],
    ["Balance mismatch phone issue", item.balanceMismatchPhoneIssue ? "Yes" : "No"],
    ["Correct phone source", item.correctPhoneSource],
    ["Phone matches", item.phoneMatches === false ? "No" : "Yes"],
    ["Manual data complete", item.manualDataComplete === false ? "No" : "Yes"],
    ["Status", item.status],
    ["Reason", item.reasonText],
    ["Outcome", item.outcome],
    ["Related transaction ID", item.usedByTransactionId],
    ["First seen", formatTime(item.firstSeenAt)],
    ["Last seen", formatTime(item.lastSeenAt)],
    ["Submitted", formatTime(item.submittedAt)],
    ["Removed", formatTime(item.removedFromReviewAt)],
    ["Last error", item.lastError]
  ];
  els.historyDetails.innerHTML = fields.map(([label, value]) => `
    <dt>${html(label)}</dt><dd>${html(value || "-")}</dd>
  `).join("");
  const actions = Array.isArray(item.actions) ? [...item.actions].reverse() : [];
  els.historyActions.innerHTML = actions.map((action) => `
    <div class="history-action">
      <strong>${html(action.label || action.type)}</strong>
      <time>${html(formatTime(action.at))}</time>
      <span>${html(JSON.stringify(action.detail || {}))}</span>
    </div>
  `).join("") || `<div class="history-action"><span>No action events recorded.</span></div>`;
  els.historyDialog.showModal();
}

function showOffline(error) {
  if (!offlineSince) offlineSince = new Date();
  els.runState.textContent = "Offline";
  els.runState.classList.remove("running");
  els.runState.classList.add("offline");
  els.errorText.textContent = `Server offline since ${offlineSince.toLocaleTimeString()}. Restart start.cmd. ${error.message}`;
}

function showLiveConfirm() {
  els.liveConfirm.hidden = false;
  els.liveConfirmInput.value = "";
  els.liveConfirmInput.focus();
}

function hideLiveConfirm() {
  els.liveConfirm.hidden = true;
  els.liveConfirmInput.value = "";
}

async function refresh() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error(`Status ${response.status}`);
    render(await response.json());
  } catch (error) {
    showOffline(error);
  }
}

els.startBtn.addEventListener("click", () => post("/api/start"));
els.stopBtn.addEventListener("click", () => post("/api/stop"));
els.runOnceBtn.addEventListener("click", () => post("/api/run-once"));
els.saveConfigBtn.addEventListener("click", () => post("/api/config", {
  checkIntervalMs: Number(els.intervalInput.value) * 1000,
  reviewUrls: els.reviewUrlsInput.value,
  dashboardRefreshMs: Number(els.dashboardRefreshInput.value) * 60000,
  dateScope: els.dateScopeInput.value,
  maxItemsPerCycle: Number(els.maxInput.value),
  minAmount: Number(els.amountMinInput.value),
  maxAmount: Number(els.amountMaxInput.value),
  enableWrongAmount: els.enableWrongAmountInput.checked,
  enableWrongPhone: els.enableWrongPhoneInput.checked,
  enableManualApproval: els.enableManualApprovalInput.checked,
  enableBalanceMismatch: els.enableBalanceMismatchInput.checked
}));

els.saveTelegramBtn.addEventListener("click", () => {
  const patch = {
    enableTelegramFollowup: els.enableTelegramFollowupInput.checked
  };
  if (els.telegramTokenInput.value.trim()) {
    patch.telegramBotToken = els.telegramTokenInput.value.trim();
    els.telegramTokenInput.value = "";
  }
  post("/api/config", patch);
});

els.importChatIdsBtn.addEventListener("click", async () => {
  setBusy(true);
  try {
    const response = await fetch("/api/chat-ids/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: els.chatImportInput.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Import failed");
    els.chatImportInput.value = "";
    render(payload.status);
    await refreshChatIds();
    els.telegramStatus.textContent = `Imported ${payload.result.imported}, skipped ${payload.result.skipped}`;
  } catch (error) {
    showOffline(error);
  } finally {
    setBusy(false);
  }
});

els.importChatIdFileBtn.addEventListener("click", async () => {
  const file = els.chatImportFileInput.files?.[0];
  if (!file) {
    els.telegramStatus.textContent = "Choose an Excel or CSV file first.";
    return;
  }
  setBusy(true);
  try {
    const data = await readFileAsBase64(file);
    const response = await fetch("/api/chat-ids/import-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, data })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "File import failed");
    els.chatImportFileInput.value = "";
    chatIdItems = payload.items || [];
    render(payload.status);
    renderChatIds();
    els.telegramStatus.textContent = `File imported ${payload.result.imported}, skipped ${payload.result.skipped} (${payload.result.extracted} extracted)`;
  } catch (error) {
    showOffline(error);
  } finally {
    setBusy(false);
  }
});

els.chatIdList.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-chat-edit]");
  const deleteButton = event.target.closest("[data-chat-delete]");
  const saveButton = event.target.closest("[data-chat-save]");
  const cancelButton = event.target.closest("[data-chat-cancel]");

  if (editButton) {
    editingChatAgentKey = editButton.dataset.chatEdit;
    renderChatIds();
    return;
  }
  if (deleteButton) {
    const agentName = deleteButton.dataset.chatDelete;
    if (confirm(`Delete chat ID for ${agentName}?`)) {
      deleteChatId(agentName);
    }
    return;
  }
  if (saveButton) {
    const row = saveButton.closest("tr");
    const agentName = row.querySelector("[data-chat-edit-agent]")?.value.trim();
    const chatId = row.querySelector("[data-chat-edit-id]")?.value.trim();
    saveChatId(agentName, chatId);
    return;
  }
  if (cancelButton) {
    editingChatAgentKey = "";
    renderChatIds();
  }
});

els.modeBtn.addEventListener("click", () => {
  if (!currentStatus) return;
  if (!currentStatus.dryRun) {
    post("/api/mode", { dryRun: true });
    return;
  }
  showLiveConfirm();
});

els.confirmLiveBtn.addEventListener("click", () => {
  post("/api/mode", { dryRun: false, confirm: els.liveConfirmInput.value.trim() });
});

els.cancelLiveBtn.addEventListener("click", hideLiveConfirm);

els.liveConfirmInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    post("/api/mode", { dryRun: false, confirm: els.liveConfirmInput.value.trim() });
  }
  if (event.key === "Escape") {
    hideLiveConfirm();
  }
});

els.historySearch.addEventListener("input", () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(refreshHistory, 250);
});

els.historyRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-ref]");
  if (button) openHistoryDetails(button.dataset.historyRef);
});

els.closeHistoryDialog.addEventListener("click", () => els.historyDialog.close());
els.historyDialog.addEventListener("click", (event) => {
  if (event.target === els.historyDialog) els.historyDialog.close();
});

refresh();
refreshHistory();
refreshChatIds();
setInterval(refresh, 3000);
setInterval(refreshHistory, 10000);
setInterval(refreshChatIds, 30000);
