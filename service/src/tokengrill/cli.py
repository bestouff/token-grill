import argparse
import sys

from tokengrill import API_VERSION, __version__


def _version() -> int:
    print(f"tokengrill {__version__} (D-Bus API {API_VERSION})")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tokengrill")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the package and D-Bus API versions")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 2
    if args.command == "version":
        return _version()
    print(f"tokengrill: unknown command {args.command}", file=sys.stderr)
    return 2
