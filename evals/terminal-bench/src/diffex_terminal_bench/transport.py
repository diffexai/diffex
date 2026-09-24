"""Bounded retries for idempotent Daytona evidence and volume requests."""

import asyncio
from collections.abc import Awaitable, Callable
import random

from daytona.common.errors import DaytonaConnectionError, DaytonaError, DaytonaTimeoutError


async def retry_transport[T](operation: Callable[[], Awaitable[T]], *, request_timeout: float = 20, total_timeout: float = 90) -> T:
    # The outer bound includes backoff and all requests; each request is also
    # bounded so a lost connection cannot consume the entire retry budget.
    async with asyncio.timeout(total_timeout):
        for attempt in range(3):
            try:
                async with asyncio.timeout(request_timeout):
                    return await operation()
            except Exception as exc:
                transient = isinstance(exc, (TimeoutError, ConnectionError, DaytonaConnectionError, DaytonaTimeoutError))
                if isinstance(exc, DaytonaError):
                    transient |= exc.status_code in (408, 429, 500, 502, 503, 504)
                if not transient or attempt == 2:
                    raise
                # Cleanup may still be finishing its seven-second TERM/KILL
                # cycle after a lost RPC response. Cover that publication lag.
                delay = 4 * 2 ** attempt + random.uniform(0, 0.25)
                if isinstance(exc, DaytonaError):
                    for key, value in exc.headers.items():
                        if key.lower().startswith("retry-after"):
                            try:
                                delay = max(delay, float(value))
                            except (ValueError, TypeError):
                                pass
                await asyncio.sleep(delay)
    raise TimeoutError("Transport retry budget exhausted")
