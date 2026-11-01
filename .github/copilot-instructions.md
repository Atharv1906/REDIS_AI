# Project invariants

- Read ARCHITECTURE.md before planning or changing behavior.
- This is a local educational RESP2 subset, not Redis itself.
- Keep the server core standard-library-only and binary-safe.
- Dispatch commands without awaits so each command remains atomic.
- Use monotonic TTL deadlines and preserve byte accounting on every mutation.
- Validate all SET options before changing state. Failed conditions must not evict.
- Keep loopback defaults, explicit bounds, and explicit error responses.
- Never add credentials, external AI calls, persistence or production claims silently.
- Do not upload source, data or secrets to external AI services.
- Add focused unittest coverage; run python -m unittest discover -s tests -v.
- Document behavior changes, supported commands and compatibility limitations.
