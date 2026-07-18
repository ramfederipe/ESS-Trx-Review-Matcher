const fs = require("fs");
const https = require("https");
const path = require("path");
const { normalizeAgentKey } = require("./agentKey");

class TelegramClient {
  constructor(dataDir, config) {
    this.config = config;
    this.chatIdsPath = path.join(dataDir, "chat_ids.json");
    this.followupsPath = path.join(dataDir, "tg_followups.json");
    this.chatIds = this.loadJson(this.chatIdsPath, {});
    this.followups = this.loadJson(this.followupsPath, {});
    this.lastUpdateId = Number(config.telegramLastUpdateId) || 0;
  }

  loadJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  saveChatIds() {
    fs.writeFileSync(this.chatIdsPath, JSON.stringify(this.chatIds, null, 2));
  }

  saveFollowups() {
    fs.writeFileSync(this.followupsPath, JSON.stringify(this.followups, null, 2));
  }

  normalizeAgentKey(agentName) {
    return normalizeAgentKey(agentName);
  }

  importChatIds(text) {
    const result = { imported: 0, skipped: 0, rows: [] };
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = parseChatIdLine(line);
      if (!parsed) {
        result.skipped += 1;
        result.rows.push({ line, ok: false });
        continue;
      }
      const agentKey = this.normalizeAgentKey(parsed.agentName);
      const chatId = parsed.chatId;
      this.chatIds[agentKey] = chatId;
      result.imported += 1;
      result.rows.push({ agentKey, chatId, ok: true });
    }
    this.saveChatIds();
    return result;
  }

  setChatId(agentName, chatId) {
    const agentKey = this.normalizeAgentKey(agentName);
    const cleanChatId = String(chatId || "").trim();
    if (!agentKey) throw new Error("Agent name is required");
    if (!/^-?\d{5,}$/.test(cleanChatId)) throw new Error("Chat ID must be numeric");
    this.chatIds[agentKey] = cleanChatId;
    this.saveChatIds();
    return { agentKey, chatId: cleanChatId };
  }

  deleteChatId(agentName) {
    const agentKey = this.normalizeAgentKey(agentName);
    if (!agentKey) throw new Error("Agent name is required");
    const existed = Object.prototype.hasOwnProperty.call(this.chatIds, agentKey);
    delete this.chatIds[agentKey];
    this.saveChatIds();
    return { agentKey, deleted: existed };
  }

  getChatId(agentName) {
    return this.chatIds[this.normalizeAgentKey(agentName)] || "";
  }

  listChatIds() {
    return Object.entries(this.chatIds)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentKey, chatId]) => ({ agentKey, chatId }));
  }

  hasToken() {
    return Boolean(String(this.config.telegramBotToken || "").trim());
  }

  async api(method, payload = {}) {
    const token = String(this.config.telegramBotToken || "").trim();
    if (!token) throw new Error("Telegram bot token is missing");
    const body = JSON.stringify(payload);
    const options = {
      method: "POST",
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 20000
    };
    return new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (!parsed.ok) reject(new Error(parsed.description || `Telegram ${response.statusCode}`));
            else resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(new Error("Telegram request timed out"));
      });
      request.write(body);
      request.end();
    });
  }

  async sendBalanceFollowup(candidate) {
    const chatId = this.getChatId(candidate.agentName);
    if (!chatId) return { sent: false, reason: "chat id not found" };
    const existing = this.followups[candidate.ref];
    if (existing && ["sent", "yes", "no", "approved", "removed"].includes(existing.status)) {
      return { sent: false, reason: `already ${existing.status}` };
    }

    const amount = formatAmount(candidate.transactionAmount);
    const balance = formatAmount(candidate.smsCurrentBalance);
    const text = [
      `Agent:${candidate.agentName}`,
      `Ref:${candidate.gatewayTransactionId}`,
      `Amount:${amount}`,
      `<b>Phone:${candidate.customerPhone}</b>`,
      `Balance: ${balance}`,
      "",
      "hi team please check if you received this Deposit also help to confirm if your wallet balance is Correct?"
    ].join("\n");
    const message = await this.api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "Yes Received", callback_data: `bm_yes:${candidate.ref}` },
          { text: "Not Received", callback_data: `bm_no:${candidate.ref}` }
        ]]
      }
    });
    this.followups[candidate.ref] = {
      status: "sent",
      sentAt: new Date().toISOString(),
      ref: candidate.ref,
      gatewayTransactionId: candidate.gatewayTransactionId,
      agentName: candidate.agentName,
      agentKey: this.normalizeAgentKey(candidate.agentName),
      reviewUrl: candidate.reviewUrl || "",
      chatId,
      messageId: message.message_id,
      messageText: text
    };
    this.saveFollowups();
    return { sent: true, chatId, messageId: message.message_id };
  }

  async pollReplies() {
    if (!this.hasToken()) return [];
    const updates = await this.api("getUpdates", {
      offset: this.lastUpdateId ? this.lastUpdateId + 1 : undefined,
      timeout: 0,
      allowed_updates: ["callback_query"]
    });
    const commands = [];
    for (const update of updates || []) {
      if (Number.isFinite(Number(update.update_id))) {
        this.lastUpdateId = Math.max(this.lastUpdateId, Number(update.update_id));
        this.config.telegramLastUpdateId = this.lastUpdateId;
      }
      const callback = update.callback_query;
      const data = callback?.data || "";
      const match = data.match(/^bm_(yes|no):([A-Z0-9]+)$/i);
      if (!match) continue;
      const action = match[1].toLowerCase();
      const ref = match[2].toUpperCase();
      this.followups[ref] = {
        ...(this.followups[ref] || { ref }),
        status: action,
        respondedAt: new Date().toISOString(),
        responseFrom: confirmedBy(callback.from),
        callbackQueryId: callback.id
      };
      commands.push({
        ref,
        action,
        callbackQueryId: callback.id,
        confirmedBy: confirmedBy(callback.from),
        reviewUrl: this.followups[ref]?.reviewUrl || "",
        chatId: callback.message?.chat?.id,
        messageId: callback.message?.message_id,
        messageText: callback.message?.text || ""
      });
    }
    if ((updates || []).length) this.saveFollowups();
    return commands;
  }

  async acknowledge(callbackQueryId, text) {
    if (!callbackQueryId) return;
    await this.api("answerCallbackQuery", { callback_query_id: callbackQueryId, text }).catch(() => {});
  }

  async updateFollowupMessage(command, statusText) {
    const followup = this.followups[command.ref] || {};
    const chatId = command.chatId || followup.chatId;
    const messageId = command.messageId || followup.messageId;
    const baseText = followup.messageText || command.messageText || "";
    if (!chatId || !messageId || !baseText) return { updated: false, reason: "message details missing" };
    const text = [
      baseText.replace(/\n+Status:.*$/is, "").trim(),
      "",
      `Status:${statusText}`,
      `Confirmed By:${command.confirmedBy || followup.responseFrom || "Unknown"}`
    ].join("\n");
    await this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
    this.followups[command.ref] = {
      ...followup,
      messageText: text,
      messageEditedAt: new Date().toISOString(),
      confirmedBy: command.confirmedBy || followup.responseFrom || ""
    };
    this.saveFollowups();
    return { updated: true, chatId, messageId };
  }

  getFollowupStatus(ref) {
    const followup = this.followups[ref];
    if (!followup) return null;
    const labelByStatus = {
      sent: "Waiting",
      yes: "Yes Received",
      no: "Not Received",
      approved: "Yes Received",
      removed: "Not Received"
    };
    return {
      status: followup.status || "",
      label: labelByStatus[followup.status] || followup.status || "",
      confirmedBy: followup.confirmedBy || followup.responseFrom || "",
      respondedAt: followup.respondedAt || "",
      completedAt: followup.completedAt || ""
    };
  }

  markDone(ref, status, extra = {}) {
    this.followups[ref] = {
      ...(this.followups[ref] || { ref }),
      status,
      completedAt: new Date().toISOString(),
      ...extra
    };
    this.saveFollowups();
  }

  getStatus() {
    return {
      hasToken: this.hasToken(),
      chatIdCount: Object.keys(this.chatIds).length,
      pendingFollowups: Object.values(this.followups).filter((item) => item.status === "sent").length
    };
  }
}

function parseChatIdLine(line) {
  const normalized = String(line || "").trim().replace(/[，,=\t]+/g, " ");
  const separated = normalized.match(/^([A-Za-z0-9-]+)\s+(-?\d{5,})$/);
  if (separated) return { agentName: separated[1], chatId: separated[2] };

  const loose = normalized.match(/([A-Za-z0-9]+-[A-Za-z0-9-]+).*?(-?\d{5,})\s*$/);
  if (loose) return { agentName: loose[1], chatId: loose[2] };

  return null;
}

function confirmedBy(from) {
  if (!from) return "Unknown";
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id || "Unknown");
}

function formatAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(value || "");
}

module.exports = {
  TelegramClient
};
