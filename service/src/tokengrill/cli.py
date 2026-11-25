import argparse
import asyncio
import sys

from tokengrill import API_VERSION, __version__


def _version() -> int:
    print(f"tokengrill {__version__} (D-Bus API {API_VERSION})")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tokengrill")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the package and D-Bus API versions")
    run = commands.add_parser("run", help="serve the D-Bus interface until the last client leaves")
    run.add_argument("--idle-seconds", type=float, default=60, help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 2
    if args.command == "version":
        return _version()
    if args.command == "run":
        from tokengrill.service import run_service

        return asyncio.run(run_service(args.idle_seconds))
    print(f"tokengrill: unknown command {args.command}", file=sys.stderr)
    return 2
