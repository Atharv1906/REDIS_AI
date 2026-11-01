"use strict";

class CacheEngine {
  constructor({ clock = () => performance.now(), maxKeys = 50 } = {}) {
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.data = new Map();
    this.semantic = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  static normalizeKey(key) {
    const cleaned = String(key ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned) return "";
    if (cleaned.includes(":")) return cleaned;
    return cleaned.replace(/\s+/g, ":");
  }

  static translateToCommand(input) {
    const text = String(input ?? "").trim();
    if (!text) return "";

    if (/^(?:PING|SET|GET|DEL|EXISTS|TTL|EXPIRE|PERSIST|KEYS|DBSIZE|FLUSHDB|HELP|ECHO)\b/i.test(text)) {
      return text;
    }

    const lower = text.toLowerCase();
    const match = lower.match(/^(set|get|delete|del|exists|ttl|expire|persist|flushdb|help|ping)\b/);
    if (!match) {
      const withAs = text.match(/^(.+?)\s+(?:as|=)\s*(.+)$/i);
      if (withAs) {
        const key = CacheEngine.normalizeKey(withAs[1]);
        const value = withAs[2].trim();
        return `SET ${key} ${JSON.stringify(value)}`;
      }
      const parts = text.split(/\s+/);
      if (parts.length >= 3) {
        const value = parts.pop();
        const key = CacheEngine.normalizeKey(parts.join(" "));
        return `SET ${key} ${JSON.stringify(value)}`;
      }
      return "";
    }

    const command = match[1].toUpperCase();
    if (command === "SET") {
      const rest = text.replace(/^set\s+/i, "").trim();
      const withAs = rest.match(/^(.+?)\s+(?:as|=)\s*(.+)$/i);
      if (withAs) {
        const key = CacheEngine.normalizeKey(withAs[1]);
        return `SET ${key} ${JSON.stringify(withAs[2].trim())}`;
      }
      const parts = rest.split(/\s+/);
      if (parts.length >= 2) {
        const value = parts.pop();
        const key = CacheEngine.normalizeKey(parts.join(" "));
        return `SET ${key} ${JSON.stringify(value)}`;
      }
      return "";
    }

    if (["GET", "DEL", "EXISTS", "TTL", "PERSIST"].includes(command)) {
      const rest = text.replace(new RegExp(`^${command}\\s+`, "i"), "").trim();
      const key = CacheEngine.normalizeKey(rest);
      return `${command} ${key}`;
    }

    if (command === "HELP") return "HELP";
    if (command === "PING") return "PING";
    if (command === "FLUSHDB") return "FLUSHDB";
    return "";
  }

  async executeAsync(input, llm) {
    const trimmed = String(input ?? "").trim();
    const [raw] = CacheEngine.tokenize(trimmed);
    const command = (raw || "").toUpperCase();
    if (command !== "SSET" && command !== "SGET") return this.execute(input);
    if (!llm) throw new Error("Semantic commands need the LLM module. Open llm.js and refresh.");
    const [, ...args] = CacheEngine.tokenize(trimmed);
    if (command === "SSET") {
      if (args.length < 2) throw new Error("Use SSET key value — the key is the question to match.");
      const [key, value] = args;
      const vector = await llm.embed(key);
      if (this.semantic.size >= this.maxKeys && !this.semantic.has(key)) {
        this.semantic.delete(this.semantic.keys().next().value);
      }
      this.semantic.set(key, { value, embedding: vector });
      return "OK";
    }
    if (args.length < 1) throw new Error("Use SGET query [threshold].");
    const query = args[0];
    const threshold = args[1] ? Number(args[1]) : 0.75;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error("Threshold must be between 0 and 1.");
    }
    if (this.semantic.size === 0) { this.misses++; return "(nil) — no semantic keys stored yet. Try SSET first."; }
    const vector = await llm.embed(query);
    let best = null;
    for (const [key, entry] of this.semantic) {
      const score = llm.cosine(vector, entry.embedding);
      if (!best || score > best.score) best = { key, value: entry.value, score };
    }
    if (!best || best.score < threshold) {
      this.misses++;
      return `(nil) — closest "${best.key}" scored ${best.score.toFixed(3)}, below ${threshold}.`;
    }
    this.hits++;
    return `${JSON.stringify(best.value)}  // matched "${best.key}" @ ${best.score.toFixed(3)}`;
  }

  sweep() {
    const now = this.clock();
    for (const [key, entry] of this.data) {
      if (entry.deadline !== null && entry.deadline <= now) this.data.delete(key);
    }
  }

  entries() {
    this.sweep();
    return [...this.data].map(([key, entry]) => ({
      key, value: entry.value,
      ttl: entry.deadline === null ? null : Math.max(0, Math.ceil((entry.deadline - this.clock()) / 1000)),
    }));
  }

  static tokenize(input) {
    const tokens = [];
    let token = "", quote = null, started = false;
    for (let i = 0; i < input.length; i++) {
      const character = input[i];
      if (character === "\\" && quote === '"' && ["n", "r", "t", "b", "f"].includes(input[i + 1])) {
        const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        token += escapes[input[++i]];
        started = true;
      } else if (character === "\\" && input[i + 1] && (input[i + 1] === quote || input[i + 1] === "\\" || (!quote && /[\s"']/.test(input[i + 1])))) {
        token += input[++i];
        started = true;
      } else if (quote) {
        if (character === quote) quote = null;
        else token += character;
      } else if (character === '"' || character === "'") {
        quote = character;
        started = true;
      } else if (/\s/.test(character)) {
        if (started) tokens.push(token);
        token = ""; started = false;
      } else {
        token += character; started = true;
      }
    }
    if (quote) throw new Error("Unclosed quote. Wrap values with spaces in matching quotes.");
    if (started) tokens.push(token);
    return tokens;
  }

  explain(command, response = "", failed = false) {
    const text = String(command ?? "").trim();
    if (!text) return "No command was entered, so the cache stayed unchanged.";
    let tokens = [];
    try {
      tokens = CacheEngine.tokenize(text);
    } catch {
      tokens = text.split(/\s+/).filter(Boolean);
    }
    const [raw, ...args] = tokens;
    const commandName = (raw || "").toUpperCase();
    const formatKey = key => key === undefined || key === null ? "that key" : `"${String(key)}"`;
    const countSuffix = count => `${count} key${count === 1 ? "" : "s"}`;
    if (failed) {
      if (commandName === "SET" && args[0]) {
        return `SET was rejected before it could write to ${formatKey(args[0])}, so the previous value stayed in place. The cache did not change.`;
      }
      return `This command was rejected before it could change the cache, so nothing was added, deleted, or updated.`;
    }
    switch (commandName) {
      case "HELP":
        return "HELP lists the commands this browser playground supports, so you can see the valid Redis-style actions available right now.";
      case "PING":
        return args.length ? `PING replied with the message you sent, which is why the cache echoed the same text back to you.` : "PING is a health check: it confirms the cache is responding and ready for more commands.";
      case "SET": {
        const [key, value, ...options] = args;
        if (!key) return "SET needs a key and a value, so the command could not create or replace any entry.";
        let ttl = null;
        let condition = null;
        for (let i = 0; i < options.length; i++) {
          const option = options[i].toUpperCase();
          if ((option === "EX" || option === "PX") && i + 1 < options.length) {
            ttl = Number(options[++i]);
          } else if (option === "NX" || option === "XX") {
            condition = option;
          }
        }
        const before = this.data.has(key);
        const currentCount = this.data.size;
        if (response === "OK") {
          const expiryText = ttl !== null && Number.isFinite(ttl) ? ` It also set a ${ttl}-second expiration.` : " It has no expiry.";
          const conditionText = condition ? ` The ${condition} condition was satisfied before the write.` : " There was no conditional guard.";
          return `SET stored ${formatKey(key)} and ${before ? "replaced the prior value" : "created a new entry"}.${conditionText}${expiryText} The cache now contains ${countSuffix(currentCount)}.`;
        }
        const reason = condition === "NX" ? "the key already existed" : condition === "XX" ? "the key was missing" : "the value did not meet the command conditions";
        return `SET did not write because ${reason}. The existing entry stayed untouched, and the cache remains unchanged.`;
      }
      case "GET": {
        if (!args[0]) return "GET needs a key, so it had nothing to look up.";
        if (response === "(nil)") {
          return `GET checked ${formatKey(args[0])}, but no value was stored there. That is why it returned (nil) and counted as a miss.`;
        }
        return `GET looked up ${formatKey(args[0])}, found a saved value, and counted as a hit. The key was also moved to the most recently used position.`;
      }
      case "DEL": {
        const deleted = Number(response || 0);
        if (deleted === 0) return "DEL searched for matching keys and found none, so nothing was removed.";
        return `DEL removed ${deleted} matching key${deleted === 1 ? "" : "s"}, which is why the count went down.`;
      }
      case "EXISTS":
        return `EXISTS counted how many requested keys were currently present, so the response reflects the number of matches in the cache.`;
      case "TTL":
        return `TTL reported the remaining lifetime for ${formatKey(args[0])}. A value of -1 means no expiration, while -2 means the key is missing.`;
      case "EXPIRE":
        if (response === "0") return `EXPIRE did not find ${formatKey(args[0])}, so it left the cache alone.`;
        return `EXPIRE updated the expiration timer for ${formatKey(args[0])}, which is why the remaining lifetime changed.`;
      case "PERSIST":
        if (response === "0") return `PERSIST could not remove the expiration from ${formatKey(args[0])} because there was no active TTL to clear.`;
        return `PERSIST removed the expiration from ${formatKey(args[0])}, so the key is now persistent.`;
      case "KEYS":
        return "KEYS * listed every key currently stored in this browser cache, which is why you see the full in-memory index.";
      case "DBSIZE":
        return `DBSIZE counted the live keys in the cache, so the response is the current total number of entries.`;
      case "FLUSHDB":
        return "FLUSHDB cleared every key in the current cache, which is why the table is empty after this command.";
      default:
        return `The engine processed "${text}" and produced the response you saw. The cache state is the reason for the result.`;
    }
  }

  execute(input) {
    if (input.length > 8192) throw new Error("Command too long (8,192 characters maximum).");
    const [raw, ...args] = CacheEngine.tokenize(input);
    if (!raw) throw new Error("Enter a command, or try HELP.");
    const command = raw.toUpperCase();
    const arity = (min, max = min) => {
      if (args.length < min || args.length > max) throw new Error(`Wrong number of arguments for ${command}. Try HELP.`);
    };
    const seconds = value => {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Math.abs(Number(value)) > 2147483647) {
        throw new Error("Expiration must be an integer between -2147483647 and 2147483647 seconds.");
      }
      return Number(value);
    };
    this.sweep();
    switch (command) {
      case "HELP":
        arity(0);
        return "SET key value [EX seconds] [NX | XX]\nGET key · DEL key [key ...] · EXISTS key [key ...]\nTTL key · EXPIRE key seconds · PERSIST key\nKEYS * · DBSIZE · FLUSHDB · PING [message]\nSSET key value — semantic set (embeds key as the question)\nSGET query [threshold] — nearest semantic match (default 0.75)\nUse quotes for values with spaces. 50 keys max; LRU eviction.\nBrowser subset only — not a connection to the RESP2 server.";
      case "PING":
        arity(0, 1); return args[0] ?? "PONG";
      case "SET": {
        arity(2, 5);
        const [key, value, ...options] = args;
        const encoder = new TextEncoder();
        if (encoder.encode(key).length > 1024 || encoder.encode(value).length > 4096) {
          throw new Error("Use keys up to 1,024 UTF-8 bytes and values up to 4,096 UTF-8 bytes.");
        }
        let expiry = null, condition = null;
        for (let i = 0; i < options.length; i++) {
          const option = options[i].toUpperCase();
          if (option === "EX" && expiry === null && i + 1 < options.length) {
            expiry = seconds(options[++i]);
            if (expiry <= 0) throw new Error("SET expiration must be greater than zero.");
          } else if ((option === "NX" || option === "XX") && condition === null) {
            condition = option;
          } else throw new Error("Use SET key value [EX seconds] [NX | XX].");
        }
        if ((condition === "NX" && this.data.has(key)) || (condition === "XX" && !this.data.has(key))) return "(nil)";
        this.data.delete(key);
        if (this.data.size >= this.maxKeys) this.data.delete(this.data.keys().next().value);
        this.data.set(key, { value, deadline: expiry === null ? null : this.clock() + expiry * 1000 });
        return "OK";
      }
      case "GET": {
        arity(1);
        const entry = this.data.get(args[0]);
        if (!entry) { this.misses++; return "(nil)"; }
        this.hits++;
        this.data.delete(args[0]); this.data.set(args[0], entry);
        return JSON.stringify(entry.value);
      }
      case "DEL":
        arity(1, 128); return String(args.reduce((count, key) => count + Number(this.data.delete(key)), 0));
      case "EXISTS":
        arity(1, 128); return String(args.reduce((count, key) => count + Number(this.data.has(key)), 0));
      case "TTL": {
        arity(1);
        const entry = this.data.get(args[0]);
        return String(!entry ? -2 : entry.deadline === null ? -1 : Math.max(0, Math.floor((entry.deadline - this.clock()) / 1000)));
      }
      case "EXPIRE": {
        arity(2);
        const ttl = seconds(args[1]);
        const entry = this.data.get(args[0]);
        if (!entry) return "0";
        if (ttl <= 0) this.data.delete(args[0]);
        else entry.deadline = this.clock() + ttl * 1000;
        return "1";
      }
      case "PERSIST": {
        arity(1);
        const entry = this.data.get(args[0]);
        if (!entry || entry.deadline === null) return "0";
        entry.deadline = null; return "1";
      }
      case "KEYS":
        arity(1);
        if (args[0] !== "*") throw new Error("This playground only supports KEYS *; use the search box to filter.");
        return JSON.stringify([...this.data.keys()]);
      case "DBSIZE":
        arity(0); return String(this.data.size);
      case "FLUSHDB":
        arity(0); this.data.clear(); return "OK";
      default:
        throw new Error(`Unknown command "${raw}". Try HELP for the browser command list.`);
    }
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { CacheEngine };
