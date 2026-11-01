"""Single-event-loop byte store with monotonic expiration and logical LRU limits."""

import time
from collections import OrderedDict
from collections.abc import Callable

MAX_KEY = 1024
MAX_VALUE = 1024 * 1024
ENTRY_OVERHEAD = 64


class Store:
    def __init__(
        self,
        max_bytes: int = 16 * 1024 * 1024,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self.max_bytes = max_bytes
        self.clock = clock
        self.data: OrderedDict[bytes, bytes] = OrderedDict()
        self.deadlines: OrderedDict[bytes, float] = OrderedDict()
        self.used_bytes = 0

    def delete(self, key: bytes) -> int:
        value = self.data.pop(key, None)
        self.deadlines.pop(key, None)
        if value is None:
            return 0
        self.used_bytes -= len(key) + len(value) + ENTRY_OVERHEAD
        return 1

    def exists(self, key: bytes) -> bool:
        deadline = self.deadlines.get(key)
        if deadline is not None and deadline <= self.clock():
            self.delete(key)
        return key in self.data

    def get(self, key: bytes) -> bytes | None:
        if not self.exists(key):
            return None
        self.data.move_to_end(key)
        return self.data[key]

    def sweep(self, limit: int | None = None) -> None:
        count = len(self.deadlines) if limit is None else min(limit, len(self.deadlines))
        now = self.clock()
        for _ in range(count):
            key, deadline = self.deadlines.popitem(last=False)
            if deadline <= now:
                self.delete(key)
            else:
                self.deadlines[key] = deadline

    def set(
        self,
        key: bytes,
        value: bytes,
        ttl_ms: int | None = None,
        condition: bytes | None = None,
    ) -> bool:
        if len(key) > MAX_KEY or len(value) > MAX_VALUE:
            raise ValueError("key or value exceeds limit")
        cost = len(key) + len(value) + ENTRY_OVERHEAD
        if cost > self.max_bytes:
            raise ValueError("item exceeds logical memory budget")
        present = self.exists(key)
        if (condition == b"NX" and present) or (condition == b"XX" and not present):
            return False
        self.sweep()
        self.delete(key)
        while self.used_bytes + cost > self.max_bytes:
            self.delete(next(iter(self.data)))
        self.data[key] = value
        self.used_bytes += cost
        if ttl_ms is not None:
            self.deadlines[key] = self.clock() + ttl_ms / 1000
        return True

    def expire(self, key: bytes, ttl_ms: int) -> int:
        if not self.exists(key):
            return 0
        if ttl_ms <= 0:
            self.delete(key)
        else:
            self.deadlines[key] = self.clock() + ttl_ms / 1000
        return 1

    def ttl(self, key: bytes, milliseconds: bool = False) -> int:
        if not self.exists(key):
            return -2
        deadline = self.deadlines.get(key)
        if deadline is None:
            return -1
        return max(0, int((deadline - self.clock()) * (1000 if milliseconds else 1)))

    def persist(self, key: bytes) -> int:
        if not self.exists(key) or key not in self.deadlines:
            return 0
        del self.deadlines[key]
        return 1

    def clear(self) -> None:
        self.data.clear()
        self.deadlines.clear()
        self.used_bytes = 0
