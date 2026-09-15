"""Recover only sandboxes named by retained benchmark trial labels."""

import argparse
import asyncio
from pathlib import Path

from daytona import AsyncDaytona

from diffex_terminal_bench.daytona_backend import confirm_cleanup
from diffex_terminal_bench.gate import read_json


async def recover(root: Path) -> None:
    failed = []
    async with AsyncDaytona() as client:
        for request in sorted(root.glob("*/*/cleanup-request.json")):
            directory = request.parent
            report = await confirm_cleanup(client, directory, read_json(request)["label"],
                                           report_path=directory / "sandbox-recovery.json")
            if not report["confirmed"]:
                failed.append(directory.name)
    if failed:
        raise RuntimeError(f"Unconfirmed sandbox cleanup: {', '.join(failed)}")
    print("Confirmed no remaining sandboxes for retained trial labels")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not args.output.is_dir():
        parser.error("The output directory does not exist")
    asyncio.run(recover(args.output))
