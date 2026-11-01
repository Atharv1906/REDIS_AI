"""Bounded RESP2 array-of-bulk-strings codec."""

import asyncio

MAX_ARGS = 128
MAX_BULK = 1024 * 1024
MAX_REQUEST = 2 * MAX_BULK + 4096
MAX_LINE = 128


class ProtocolError(ValueError):
    pass


async def _line(reader: asyncio.StreamReader) -> bytes:
    try:
        line = await reader.readuntil(b"\r\n")
    except asyncio.LimitOverrunError as exc:
        raise ProtocolError("request line too long") from exc
    if len(line) > MAX_LINE:
        raise ProtocolError("request line too long")
    return line


def _length(line: bytes, prefix: bytes, maximum: int) -> int:
    digits = line[1:-2]
    if line[:1] != prefix or not digits or not digits.isdigit():
        raise ProtocolError("expected nonnegative RESP length")
    value = int(digits)
    if value > maximum:
        raise ProtocolError("RESP length exceeds limit")
    return value


async def read_request(reader: asyncio.StreamReader) -> list[bytes]:
    line = await _line(reader)
    size = len(line)
    count = _length(line, b"*", MAX_ARGS)
    if count == 0:
        raise ProtocolError("empty command")
    args = []
    for _ in range(count):
        line = await _line(reader)
        length = _length(line, b"$", MAX_BULK)
        size += len(line) + length + 2
        if size > MAX_REQUEST:
            raise ProtocolError("request exceeds limit")
        payload = await reader.readexactly(length + 2)
        if payload[-2:] != b"\r\n":
            raise ProtocolError("invalid bulk terminator")
        args.append(payload[:-2])
    return args


def bulk(value: bytes | None) -> bytes:
    if value is None:
        return b"$-1\r\n"
    return b"$" + str(len(value)).encode("ascii") + b"\r\n" + value + b"\r\n"


def integer(value: int) -> bytes:
    return b":" + str(value).encode("ascii") + b"\r\n"


def error(message: str) -> bytes:
    return b"-ERR " + message.encode("ascii") + b"\r\n"
