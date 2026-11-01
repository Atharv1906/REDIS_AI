# Ember — interactive cache playground

Open [index.html](index.html) in your browser. No installation, build step,
account, or Python process is needed for the responsive web experience.
It includes a working command console, live key explorer, expiration countdowns,
hit statistics, search, deletion, reset, and a built-in tutor hint for every
command. Try `HELP` for supported commands and use "Why did this happen?" to
understand the cache result in plain English.

The web playground is a **browser-local simulation**, not a connection to the
Python TCP server. It stores up to 50 keys in this tab, evicts least-recently-used
keys, and clears on refresh. No data or assets are fetched from external services.
It uses original Ember branding and is not affiliated with Redis.

Frontend logic tests (Node.js 18+; no npm packages):

```powershell
node --test tests\web.test.cjs
```

## Optional Python server

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architecture, diagrams,
planning-agent demonstration, implementation plan, command contract, AI tooling,
GitHub agent workflow, limits, and operating instructions.

This is a volatile, unauthenticated RESP2 subset for local learning, **not Redis
itself or a production replacement**. The server uses only the Python standard
library; the demo/tests use redis-py.

## Quick start (PowerShell, Python 3.11-3.13)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe server.py
```

Then in another terminal:

```powershell
.\.venv\Scripts\python.exe demo_app.py
```

The fresh-cache demo prints two misses and two hits. Server defaults to loopback
port 6379. Use REDIS_HOST/REDIS_PORT for the client and `--host`/`--port` for the
server. Stop with Ctrl+C; all cached data is lost.

Alternatively, run `docker compose up --build -d`, run the demo, then
`docker compose down`. Do not expose this service publicly.

Reusable [planning](.github/agents/plan.agent.md),
[building](.github/agents/build.agent.md) and
[review](.github/agents/review.agent.md) agents are included. Remote GitHub
execution requires an approved repository and enabled Copilot features.
