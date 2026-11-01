"use strict";

const LLM = (() => {
  const DEFAULTS = {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    chatModel: "gemini-2.5-flash",
    embedModel: "text-embedding-004",
  };
  const KEY_STORAGE = "ember_llm_key";

  function getKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
  }
  function setKey(key) {
    try { localStorage.setItem(KEY_STORAGE, key); } catch {}
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORAGE); } catch {}
  }
  async function ensureKey() {
    let key = getKey();
    if (key) return key;
    key = window.prompt("Paste your Gemini / OpenAI-compatible API key.\nStored only in this browser (localStorage).");
    if (!key) throw new Error("An API key is required for AI features.");
    setKey(key.trim());
    return key.trim();
  }

  async function call(path, body) {
    const key = await ensureKey();
    const response = await fetch(DEFAULTS.baseURL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) clearKey();
      throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  async function diagnoseError({ command, error, keys }) {
    const sample = (keys || []).slice(0, 20).join(", ") || "(empty cache)";
    const system = "You are a terse debugger for a Redis-style command playground. The playground supports: SET, GET, DEL, EXISTS, TTL, EXPIRE, PERSIST, KEYS *, DBSIZE, FLUSHDB, PING, HELP, SSET (semantic set), SGET (semantic get). Given a failed command and its error, reply with ONE sentence explaining the cause, then on a new line a corrected command the user can run. No prose beyond that.";
    const user = `Command: ${command}\nError: ${error}\nCurrent keys: ${sample}`;
    const data = await call("chat/completions", {
      model: DEFAULTS.chatModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
    });
    return data.choices?.[0]?.message?.content?.trim() || "No suggestion returned.";
  }

  async function embed(text) {
    const data = await call("embeddings", { model: DEFAULTS.embedModel, input: text });
    const vector = data.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new Error("Embedding API returned no vector.");
    return vector;
  }

  function cosine(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  return { diagnoseError, embed, cosine, ensureKey, getKey, setKey, clearKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { LLM };
