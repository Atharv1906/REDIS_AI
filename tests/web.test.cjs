const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CacheEngine } = require("../cache.js");

test("quoted values, JSON, empty values, and escaped keys are lossless", () => {
  const cache = new CacheEngine();
  for (const [key, value] of [["hello", "world"], ["", ""], ['a "quoted" key', "a\nb"], ["tab\tkey", "x"]]) {
    assert.equal(cache.execute(`SET ${JSON.stringify(key)} ${JSON.stringify(value)}`), "OK");
    assert.equal(cache.execute(`GET ${JSON.stringify(key)}`), JSON.stringify(value));
    assert.equal(cache.execute(`DEL ${JSON.stringify(key)}`), "1");
  }
  cache.execute(`SET user '{"name":"Ada"}'`);
  assert.equal(cache.data.get("user").value, '{"name":"Ada"}');
});

test("TTL expires using an injected clock and does not change hit stats", () => {
  let now = 0;
  const cache = new CacheEngine({ clock: () => now });
  cache.execute("SET short value EX 10");
  assert.equal(cache.execute("TTL short"), "10");
  now = 9500;
  assert.equal(cache.entries()[0].ttl, 1);
  assert.equal(cache.execute("TTL short"), "0");
  now = 10000;
  assert.equal(cache.execute("TTL short"), "-2");
  assert.equal(cache.execute("GET short"), "(nil)");
  assert.equal(cache.hits, 0); assert.equal(cache.misses, 1);
});

test("LRU limits and failed conditions preserve data", () => {
  const cache = new CacheEngine({ maxKeys: 2 });
  cache.execute("SET a one"); cache.execute("SET b two"); cache.execute("GET a");
  assert.equal(cache.execute("SET c three XX"), "(nil)");
  assert.equal(cache.execute("SET a new NX"), "(nil)");
  assert.equal(cache.data.size, 2);
  cache.execute("SET c three");
  assert.equal(cache.execute("GET b"), "(nil)");
  assert.equal(cache.execute("GET a"), '"one"');
  assert.equal(cache.execute("SET a new XX"), "OK");
});

test("invalid options, limits, and arities do not replace values", () => {
  const cache = new CacheEngine();
  cache.execute("SET k old");
  for (const command of [
    "SET k new EX 0", "SET k new EX -1", "SET k new EX nope", "SET k new EX",
    "SET k new NX XX", "SET k new EX 1 EX 2", "SET k new PX 10", 'SET k "open',
    `SET k "${"é".repeat(2049)}"`, "SET k new EX 2147483648", "SET",
  ]) {
    assert.throws(() => cache.execute(command), Error, command);
    assert.equal(cache.data.get("k").value, "old");
  }
  assert.throws(() => cache.execute("x".repeat(8193)));
  assert.throws(() => cache.execute("GET"));
  assert.throws(() => cache.execute("HELLO"));
});

test("key management and TTL replacement", () => {
  const cache = new CacheEngine();
  cache.execute("SET a one EX 60");
  assert.equal(cache.execute("PERSIST a"), "1");
  assert.equal(cache.execute("PERSIST a"), "0");
  assert.equal(cache.execute("TTL a"), "-1");
  assert.equal(cache.execute("EXPIRE a 60"), "1");
  cache.execute("SET a two");
  assert.equal(cache.execute("TTL a"), "-1");
  assert.equal(cache.execute("EXISTS a a missing"), "2");
  assert.equal(cache.execute("DBSIZE"), "1");
  assert.equal(cache.execute("KEYS *"), '["a"]');
  assert.throws(() => cache.execute("KEYS a*"));
  assert.equal(cache.execute("EXPIRE a 0"), "1");
  assert.equal(cache.execute("EXPIRE missing 0"), "0");
  assert.equal(cache.execute("DEL a"), "0");
  cache.execute("SET b two");
  assert.equal(cache.execute("FLUSHDB"), "OK");
  assert.equal(cache.entries().length, 0);
  assert.equal(cache.execute("PING"), "PONG");
  assert.equal(cache.execute('PING "hey there"'), "hey there");
  assert.match(cache.execute("HELP"), /Browser subset only/);
});

test("tutor explanations describe command outcomes in plain English", () => {
  const cache = new CacheEngine();
  cache.execute("SET user Ada");
  assert.match(cache.explain("SET user Ada", "OK"), /stored|created/i);
  assert.match(cache.explain("GET user", '"Ada"'), /found|hit/i);
  assert.match(cache.explain("GET missing", "(nil)"), /miss/i);
  assert.match(cache.explain("FLUSHDB", "OK"), /cleared|empty/i);
  assert.match(cache.explain("SET user Ada", "OK", true), /rejected|did not write/i);
});
