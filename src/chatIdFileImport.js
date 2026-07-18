const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { DATA_DIR } = require("./config");

function importChatIdsFromFilePayload(payload, worker) {
  const name = String(payload?.name || "");
  const data = String(payload?.data || "");
  if (!name || !data) throw new Error("Import file is required");

  const extension = path.extname(name).toLowerCase();
  if (![".xlsx", ".xlsm", ".csv", ".tsv"].includes(extension)) {
    throw new Error("Only .xlsx, .xlsm, .csv, and .tsv files are supported");
  }

  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) throw new Error("Import file was empty");
  if (buffer.length > 15 * 1024 * 1024) throw new Error("Import file is larger than 15 MB");

  const importDir = fs.mkdtempSync(path.join(DATA_DIR, "chat-import-"));
  const filePath = path.join(importDir, `import${extension}`);
  fs.writeFileSync(filePath, buffer);

  return parseChatIdFile(filePath)
    .then((parsed) => {
      const result = worker.importChatIds(parsed.text || "");
      return {
        fileName: name,
        extracted: parsed.rows || 0,
        fileSkippedRows: parsed.skipped || 0,
        ...result
      };
    })
    .finally(() => {
      fs.rmSync(importDir, { recursive: true, force: true });
    });
}

function parseChatIdFile(filePath) {
  const python = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  const script = path.join(__dirname, "parse_chat_ids.py");
  return new Promise((resolve, reject) => {
    execFile(python, [script, filePath], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(stdout || "{}"));
      } catch (parseError) {
        reject(new Error(`Could not read import file output: ${parseError.message}`));
        return;
      }
      if (error || parsed.error) {
        reject(new Error(parsed.error || stderr || error.message));
        return;
      }
      resolve(parsed);
    });
  });
}

module.exports = {
  importChatIdsFromFilePayload
};
