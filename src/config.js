const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_DIR = path.join(ROOT, "data");
const APP_VERSION = "2026-07-17.2";

const defaults = {
  reviewUrl: "https://www.ewsolutions.app/admin/transactions/txn-review",
  reviewUrls: [],
  dashboardPort: 5177,
  remoteDebuggingPort: 9222,
  chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  chromeProfileDir: "chrome-profile",
  checkIntervalMs: 30000,
  dashboardRefreshMs: 600000,
  dateScope: "all",
  maxItemsPerCycle: 3,
  minAmount: 100,
  maxAmount: 0,
  enableWrongAmount: true,
  enableWrongPhone: true,
  enableManualApproval: true,
  enableBalanceMismatch: true,
  enableTelegramFollowup: false,
  telegramBotToken: "",
  telegramLastUpdateId: 0,
  dryRun: true,
  startWorkerOnLaunch: true,
  requireGatewayMatch: true,
  allowedStatuses: [],
  postSubmitWaitMs: 3000
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  }

  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const config = { ...defaults, ...loaded };
  config.reviewUrls = normalizeReviewUrls(loaded.reviewUrls || loaded.reviewUrl || defaults.reviewUrl);
  config.reviewUrl = config.reviewUrls[0] || defaults.reviewUrl;
  if (!Object.prototype.hasOwnProperty.call(loaded, "minAmount")) {
    config.minAmount = loaded.wrongPhoneMinAmount ?? loaded.minCorrectAmount ?? defaults.minAmount;
  }
  if (!Object.prototype.hasOwnProperty.call(loaded, "maxAmount")) {
    config.maxAmount = loaded.wrongPhoneMaxAmount ?? defaults.maxAmount;
  }
  config.chromeProfileDir = path.resolve(ROOT, config.chromeProfileDir);
  config.checkIntervalMs = Math.max(5000, Number(config.checkIntervalMs) || defaults.checkIntervalMs);
  config.dashboardRefreshMs = Math.max(0, Number(config.dashboardRefreshMs) || 0);
  config.dateScope = ["all", "today", "week", "month"].includes(config.dateScope) ? config.dateScope : defaults.dateScope;
  config.maxItemsPerCycle = Math.max(1, Number(config.maxItemsPerCycle) || defaults.maxItemsPerCycle);
  const minAmount = Number(config.minAmount);
  config.minAmount = Number.isFinite(minAmount) ? Math.max(0, minAmount) : defaults.minAmount;
  config.maxAmount = Math.max(0, Number(config.maxAmount) || 0);
  config.enableWrongAmount = config.enableWrongAmount !== false;
  config.enableWrongPhone = config.enableWrongPhone !== false;
  config.enableManualApproval = config.enableManualApproval !== false;
  config.enableBalanceMismatch = config.enableBalanceMismatch !== false;
  config.enableTelegramFollowup = config.enableTelegramFollowup === true;
  config.telegramBotToken = String(config.telegramBotToken || "");
  config.telegramLastUpdateId = Math.max(0, Number(config.telegramLastUpdateId) || 0);
  config.postSubmitWaitMs = Math.max(500, Number(config.postSubmitWaitMs) || defaults.postSubmitWaitMs);
  config.allowedStatuses = Array.isArray(config.allowedStatuses) ? config.allowedStatuses : [];
  delete config.minCorrectAmount;
  delete config.wrongPhoneMinAmount;
  delete config.wrongPhoneMaxAmount;
  return config;
}

function saveConfig(config) {
  const toSave = { ...config };
  if (path.isAbsolute(toSave.chromeProfileDir)) {
    toSave.chromeProfileDir = path.relative(ROOT, toSave.chromeProfileDir) || ".";
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
}

function normalizeReviewUrls(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const urls = raw
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
  return urls.length ? urls : [defaults.reviewUrl];
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  DATA_DIR,
  APP_VERSION,
  ensureDataDir,
  loadConfig,
  saveConfig
};
