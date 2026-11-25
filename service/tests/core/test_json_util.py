import math

from tokengrill.core.json_util import (
    clamp_fraction,
    is_record,
    number_at,
    parse_record,
    record_at,
    string_at,
    to_epoch_ms,
    to_number,
)


def test_is_record_accepts_only_objects() -> None:
    assert is_record({"a": 1})
    assert is_record({})
    assert not is_record([])
    assert not is_record(None)
    assert not is_record("x")
    assert not is_record(3)


def test_parse_record_returns_none_for_bad_or_non_object_text() -> None:
    assert parse_record('{"a": 1}') == {"a": 1}
    assert parse_record('{"a": ') is None
    assert parse_record("[1]") is None
    assert parse_record("null") is None
    assert parse_record("") is None


def test_record_at_number_at_string_at() -> None:
    record = {"o": {"k": 1}, "n": 2.5, "s": "x", "e": "", "inf": math.inf, "b": True, "l": []}
    assert record_at(record, "o") == {"k": 1}
    assert record_at(record, "l") is None
    assert record_at(record, "missing") is None
    assert number_at(record, "n") == 2.5
    assert number_at(record, "inf") is None
    assert number_at(record, "b") is None
    assert number_at(record, "s") is None
    assert string_at(record, "s") == "x"
    assert string_at(record, "e") is None
    assert string_at(record, "n") is None


def test_to_epoch_ms_reads_seconds_milliseconds_and_iso() -> None:
    assert to_epoch_ms(1_700_000_000) == 1_700_000_000_000
    assert to_epoch_ms(1_700_000_000_000) == 1_700_000_000_000
    assert to_epoch_ms("2023-11-14T22:13:20Z") == 1_700_000_000_000
    assert to_epoch_ms("2023-11-14T22:13:20.123Z") == 1_700_000_000_123
    assert to_epoch_ms("2023-11-14T23:13:20+01:00") == 1_700_000_000_000
    assert to_epoch_ms("2023-11-14") == 1_699_920_000_000
    assert to_epoch_ms("not a date") is None
    assert to_epoch_ms("") is None
    assert to_epoch_ms(math.nan) is None
    assert to_epoch_ms(None) is None
    assert to_epoch_ms(True) is None


def test_to_number_reads_decimal_strings() -> None:
    assert to_number(3) == 3
    assert to_number("4.5") == 4.5
    assert to_number(" 7 ") == 7
    assert to_number("1e3") == 1000
    assert to_number("") is None
    assert to_number("  ") is None
    assert to_number("abc") is None
    assert to_number("1_0") is None
    assert to_number("nan") is None
    assert to_number("Infinity") is None
    assert to_number(math.inf) is None
    assert to_number(None) is None
    assert to_number(True) is None


def test_clamp_fraction() -> None:
    assert clamp_fraction(-1) == 0
    assert clamp_fraction(0.4) == 0.4
    assert clamp_fraction(7) == 1


def test_huge_integers_are_not_numbers() -> None:
    huge = 10**400
    assert number_at({"n": huge}, "n") is None
    assert to_epoch_ms(huge) is None
    assert to_number(huge) is None


def test_to_number_rejects_non_ascii_digits() -> None:
    assert to_number(chr(0x663)) is None
    assert to_number("1" + chr(0x663)) is None
