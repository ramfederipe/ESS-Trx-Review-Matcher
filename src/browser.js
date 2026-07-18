const fs = require("fs");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.acceptDialogsUntil = 0;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`Chrome websocket error: ${event.message || "unknown"}`));
      }, { once: true });
    });

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.javascriptDialogOpening" && Date.now() < this.acceptDialogsUntil) {
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result || {});
    });
  }

  send(method, params = {}, timeoutMs = 90000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out during ${method}`));
      }, timeoutMs);
    });
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception || {};
      const text = exception.description
        || exception.value
        || details.text
        || "Evaluation failed";
      throw new Error(text);
    }
    return result.result ? result.result.value : undefined;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
  }

  acceptDialogsFor(ms) {
    this.acceptDialogsUntil = Date.now() + ms;
  }
}

class BrowserController {
  constructor(config) {
    this.config = config;
    this.baseUrl = `http://127.0.0.1:${config.remoteDebuggingPort}`;
    this.chromeProcess = null;
    this.page = null;
  }

  async getPage() {
    await this.ensureChrome();
    const target = await this.getOrCreateTarget();
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
    this.page = client;
    return client;
  }

  async ensureChrome() {
    if (await this.isChromeReady()) return;
    if (!fs.existsSync(this.config.chromePath)) {
      throw new Error(`Chrome was not found at ${this.config.chromePath}`);
    }
    fs.mkdirSync(this.config.chromeProfileDir, { recursive: true });

    this.chromeProcess = spawn(this.config.chromePath, [
      `--remote-debugging-port=${this.config.remoteDebuggingPort}`,
      `--user-data-dir=${this.config.chromeProfileDir}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--new-window",
      "about:blank"
    ], {
      detached: true,
      stdio: "ignore"
    });
    this.chromeProcess.unref();

    for (let i = 0; i < 40; i += 1) {
      if (await this.isChromeReady()) return;
      await sleep(250);
    }
    throw new Error("Chrome did not start with remote debugging enabled.");
  }

  async isChromeReady() {
    try {
      const response = await fetch(`${this.baseUrl}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getOrCreateTarget() {
    const listResponse = await fetch(`${this.baseUrl}/json/list`);
    const targets = await listResponse.json();
    const existing = targets.find((target) => target.type === "page" && target.url.includes("ewsolutions.app"));
    if (existing && existing.webSocketDebuggerUrl) return existing;

    const encodedUrl = encodeURIComponent(this.config.reviewUrl);
    let createResponse = await fetch(`${this.baseUrl}/json/new?${encodedUrl}`, { method: "PUT" });
    if (!createResponse.ok) {
      createResponse = await fetch(`${this.baseUrl}/json/new?${encodedUrl}`);
    }
    if (!createResponse.ok) {
      throw new Error(`Chrome could not create a page: ${createResponse.status}`);
    }
    return createResponse.json();
  }
}

module.exports = {
  BrowserController,
  sleep
};
