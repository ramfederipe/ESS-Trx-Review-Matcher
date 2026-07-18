function normalizeAgentKey(agentName) {
  return String(agentName || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\d+-M\d*$/i, "")
    .replace(/\d+$/g, "");
}

module.exports = {
  normalizeAgentKey
};
