from pathlib import Path

from tokengrill.storage.jsonl import scan_jsonl

MIB = 1024 * 1024


async def test_jsonl_reads_complete_lines_and_stops_before_a_partial_one(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    path.write_bytes(b'{"a":1}\n{"b":2}\n{"c":')
    lines: list[str] = []
    offset = await scan_jsonl(path, 0, lines.append, MIB)
    assert lines == ['{"a":1}', '{"b":2}']
    assert offset == len(b'{"a":1}\n{"b":2}\n')


async def test_jsonl_skips_line_over_limit(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    path.write_bytes(b"first\n" + b"x" * (2 * MIB) + b"\nlast\n")
    lines: list[str] = []
    offset = await scan_jsonl(path, 0, lines.append, MIB)
    assert lines == ["first", "last"]
    assert offset == path.stat().st_size


async def test_jsonl_skips_unfinished_line_over_limit_without_advancing(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    path.write_bytes(b"first\n" + b"x" * (2 * MIB))
    lines: list[str] = []
    offset = await scan_jsonl(path, 0, lines.append, MIB)
    assert lines == ["first"]
    assert offset == len(b"first\n")


async def test_jsonl_resumes_from_offset(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    path.write_bytes(b"one\ntwo\n")
    lines: list[str] = []
    first = await scan_jsonl(path, 0, lines.append, MIB)
    with path.open("ab") as handle:
        handle.write(b"three\nfo")
    second = await scan_jsonl(path, first, lines.append, MIB)
    assert lines == ["one", "two", "three"]
    assert second == len(b"one\ntwo\nthree\n")


async def test_jsonl_line_spanning_chunks_is_joined(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    long_line = "y" * 200_000
    path.write_bytes(long_line.encode() + b"\n")
    lines: list[str] = []
    await scan_jsonl(path, 0, lines.append, 256 * 1024)
    assert lines == [long_line]


async def test_jsonl_decodes_multibyte_split_across_chunks(tmp_path: Path) -> None:
    path = tmp_path / "a.jsonl"
    text = chr(233) * 70_000
    path.write_bytes(text.encode() + b"\n")
    lines: list[str] = []
    await scan_jsonl(path, 0, lines.append, MIB)
    assert lines == [text]
