"use strict";

const engine = new CacheEngine();
const output = document.querySelector("#terminal-output");
const input = document.querySelector("#command-input");
const rows = document.querySelector("#key-rows");
const search = document.querySelector("#key-search");
const announcement = document.querySelector("#announcement");
let history = [];
let historyIndex = 0;
let draft = "";

function translateNaturalLanguage() {
  const raw = input.value.trim();
  if (!raw) {
    announcement.textContent = "Type a command or a natural-language instruction first.";
    return;
  }

  const translated = CacheEngine.translateToCommand(raw);
  if (!translated) {
    announcement.textContent = 'I couldn’t translate that yet. Try “set user1 name as anuj” or “GET user1:name”.';
    return;
  }

  input.value = translated;
  announcement.textContent = `Translated: ${translated}`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function attachFixButton(entry, command, errorMessage) {
  if (typeof LLM === "undefined") return;
  const wrap = document.createElement("div");
  wrap.className = "log-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tutor-button";
  button.textContent = "Fix this with AI";
  const detail = document.createElement("div");
  detail.className = "log-explanation";
  detail.hidden = true;
  wrap.append(button, detail);
  entry.append(wrap);
  button.addEventListener("click", async () => {
    if (!detail.hidden) { detail.hidden = true; return; }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Thinking…";
    try {
      const suggestion = await LLM.diagnoseError({
        command,
        error: errorMessage,
        keys: engine.entries().map(entry => entry.key),
      });
      detail.textContent = suggestion;
      detail.hidden = false;
    } catch (error) {
      detail.textContent = error.message;
      detail.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
}

function log(command, result, failed = false, explanation = null) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  if (command) {
    const line = document.createElement("div");
    line.className = "log-command";
    line.textContent = command;
    entry.append(line);
  }
  const response = document.createElement("div");
  response.className = failed ? "log-result log-error" : command ? "log-result" : "log-note";
  response.textContent = result;
  entry.append(response);
  if (explanation) {
    const tutor = document.createElement("div");
    tutor.className = "log-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tutor-button";
    button.textContent = "Why did this happen?";
    button.setAttribute("aria-expanded", "false");
    const detail = document.createElement("div");
    detail.className = "log-explanation";
    detail.hidden = true;
    detail.textContent = explanation;
    button.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
    tutor.append(button, detail);
    entry.append(tutor);
  }
  output.append(entry);
  while (output.children.length > 100) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
  return entry;
}

function render() {
  const entries = engine.entries();
  document.querySelector("#metric-keys").textContent = entries.length;
  document.querySelector("#key-count").textContent = entries.length;
  const reads = engine.hits + engine.misses;
  document.querySelector("#metric-rate").textContent = reads ? `${Math.round(engine.hits / reads * 100)}%` : "—";
  document.querySelector("#metric-reads").textContent = reads ? `${engine.hits} hit${engine.hits === 1 ? "" : "s"} / ${reads} reads` : "no reads yet";
  const encoder = new TextEncoder();
  const size = entries.reduce((total, entry) => total + encoder.encode(entry.key).length + encoder.encode(entry.value).length, 0);
  document.querySelector("#metric-memory").textContent = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
  const visible = entries.filter(entry => entry.key.toLowerCase().includes(search.value.toLowerCase()));
  // Keep the delete button focused while countdowns refresh.
  const focusedKey = rows.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  rows.replaceChildren();
  for (const entry of visible) {
    const row = document.createElement("tr");
    const keyCell = document.createElement("td");
    const name = document.createElement("div");
    name.className = "key-name"; name.textContent = entry.key || '""';
    const value = document.createElement("div");
    value.className = "key-value"; value.textContent = entry.value || '""'; value.title = entry.value;
    keyCell.append(name, value);
    const expiry = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = entry.ttl === null ? "ttl-badge" : "ttl-badge ttl-expiring";
    badge.textContent = entry.ttl === null ? "No expiry" : `${entry.ttl}s`;
    expiry.append(badge);
    const actions = document.createElement("td");
    const button = document.createElement("button");
    button.className = "delete-key"; button.type = "button"; button.textContent = "×";
    button.dataset.key = entry.key;
    button.setAttribute("aria-label", `Delete key ${entry.key || '""'}`);
    button.addEventListener("click", () => run(`DEL ${JSON.stringify(entry.key)}`));
    actions.append(button); row.append(keyCell, expiry, actions); rows.append(row);
    if (entry.key === focusedKey) button.focus({ preventScroll: true });
  }
  const empty = document.querySelector("#empty-state");
  empty.hidden = visible.length > 0;
  empty.textContent = entries.length ? "No matching keys. Try a different search." : "No keys yet. Make something with SET.";
}

async function run(command) {
  try {
    const head = command.trim().split(/\s+/)[0]?.toUpperCase();
    const needsAsync = head === "SSET" || head === "SGET";
    const result = needsAsync
      ? await engine.executeAsync(command, typeof LLM !== "undefined" ? LLM : null)
      : engine.execute(command);
    const explanation = engine.explain(command, result, false);
    log(command, result, false, explanation);
    announcement.textContent = `${head || command}: ${result}`;
  } catch (error) {
    const explanation = engine.explain(command, error.message, true);
    const entry = log(command, `Error: ${error.message}`, true, explanation);
    attachFixButton(entry, command, error.message);
    announcement.textContent = `Error: ${error.message}`;
  }
  history.push(command);
  if (history.length > 100) history.shift();
  historyIndex = history.length;
  draft = "";
  render();
}

function seed() {
  engine.data.clear(); engine.hits = 0; engine.misses = 0;
  engine.execute('SET hello "world"');
  engine.execute('SET user:42 \'{"name":"Ada","role":"builder"}\'');
  engine.execute('SET session:demo "active" EX 120');
  engine.execute('SET ideas:next "Something wonderful"');
  output.replaceChildren();
  log(null, "Welcome to your little data lab.\nTry a command below. Your data stays in this tab.");
  log('SET hello "world"', "OK");
  history = []; historyIndex = 0; draft = ""; input.value = ""; search.value = "";
  render();
}

document.querySelector("#command-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!input.value.trim()) return;
  run(input.value);
  input.value = "";
  input.focus();
});
document.querySelector("#translate-command").addEventListener("click", () => {
  translateNaturalLanguage();
});
input.addEventListener("keydown", event => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  if (historyIndex === history.length) draft = input.value;
  historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === "ArrowUp" ? -1 : 1)));
  input.value = historyIndex === history.length ? draft : history[historyIndex];
  input.setSelectionRange(input.value.length, input.value.length);
});
document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => {
  run(button.dataset.command);
  input.focus({ preventScroll: true });
}));
document.querySelector("#clear-console").addEventListener("click", () => {
  output.replaceChildren();
  announcement.textContent = "Console cleared. Cached keys are unchanged.";
});
document.querySelector("#reset-demo").addEventListener("click", () => {
  seed();
  announcement.textContent = "Demo reset. Four sample keys restored and statistics cleared.";
});
search.addEventListener("input", render);
const menu = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#navigation");
function closeMenu() {
  navigation.classList.remove("is-open");
  menu.setAttribute("aria-expanded", "false");
}
menu.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
});
navigation.querySelectorAll("a").forEach(link => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    closeMenu(); menu.focus();
  }
});
seed();
setInterval(render, 1000);
