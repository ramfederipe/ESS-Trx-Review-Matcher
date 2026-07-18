const fs = require("fs");
const http = require("http");
const path = require("path");
const { APP_VERSION, loadConfig } = require("./config");
const { TransactionWorker } = require("./worker");
const { importChatIdsFromFilePayload } = require("./chatIdFileImport");

const config = loadConfig();
const worker = new TransactionWorker(config);
const publicDir = path.join(__dirname, "..", "public");

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error && error.stack || error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack || reason);
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(path.join(publicDir, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.method === "GET" && url.pathname === "/styles.css") {
      const css = fs.readFileSync(path.join(publicDir, "styles.css"));
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      response.end(css);
      return;
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      const js = fs.readFileSync(path.join(publicDir, "app.js"));
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      response.end(js);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, worker.getStatus());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/history") {
      const query = url.searchParams.get("q") || "";
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      sendJson(response, 200, worker.searchHistory(query, limit));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat-ids") {
      sendJson(response, 200, { items: worker.getChatIds() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat-ids/import") {
      const body = await readBody(request);
      sendJson(response, 200, { result: worker.importChatIds(body.text || ""), status: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat-ids/import-file") {
      const body = await readBody(request);
      const result = await importChatIdsFromFilePayload(body, worker);
      sendJson(response, 200, { result, items: worker.getChatIds(), status: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat-ids/save") {
      const body = await readBody(request);
      sendJson(response, 200, { result: worker.setChatId(body.agentName || body.agentKey || "", body.chatId || ""), items: worker.getChatIds(), status: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat-ids/delete") {
      const body = await readBody(request);
      sendJson(response, 200, { result: worker.deleteChatId(body.agentName || body.agentKey || ""), items: worker.getChatIds(), status: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/start") {
      worker.start();
      sendJson(response, 200, worker.getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      worker.stop();
      sendJson(response, 200, worker.getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run-once") {
      const result = await worker.runOnce();
      sendJson(response, 200, { result, status: worker.getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mode") {
      const body = await readBody(request);
      if (body.dryRun === false && body.confirm !== "LIVE") {
        sendJson(response, 400, { error: "Type LIVE to enable live mode." });
        return;
      }
      worker.setDryRun(body.dryRun !== false);
      sendJson(response, 200, worker.getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(request);
      worker.updateConfig(body);
      sendJson(response, 200, worker.getStatus());
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`ESS Txn Review Checker is already running at http://127.0.0.1:${config.dashboardPort}`);
  } else {
    console.error("ESS Txn Review Checker could not start:", error.message);
  }
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
});

server.listen(config.dashboardPort, "127.0.0.1", () => {
  console.log(`ESS Txn Review Checker dashboard: http://127.0.0.1:${config.dashboardPort}`);
  console.log(`Build: ${APP_VERSION}`);
  console.log(`Mode: ${config.dryRun ? "dry-run" : "LIVE"}`);
  if (config.startWorkerOnLaunch) worker.start();
});
