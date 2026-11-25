from tokengrill.core.diagnostics import account_label, format_report, redact, request_detail, shape_of


def test_shapes_never_contain_values() -> None:
    shape = shape_of(
        {
            "access_token": "sk-abc123secretvalue",
            "usage": {"rolling": {"percent": 41, "status": "ok"}},
            "items": [1, 2, 3],
            "ok": True,
            "none": None,
        }
    )
    assert shape == (
        "{access_token: string, usage: {rolling: {percent: number, status: string}}, "
        "items: [3 items], ok: boolean, none: null}"
    )
    assert "sk-abc" not in shape
    assert "41" not in shape


def test_shapes_stop_at_three_levels_and_six_keys() -> None:
    assert shape_of({"a": {"b": {"c": {"d": 1}}}}) == "{a: {b: {c: {...}}}}"
    assert shape_of(dict.fromkeys("abcdefgh", 1)) == (
        "{a: number, b: number, c: number, d: number, e: number, f: number, ...2 more}"
    )


def test_redaction_removes_tokens_emails_uuids_and_the_home_path() -> None:
    text = (
        "read /home/test/.codex/auth.json for jane.doe@example.com id 3f2a9c1e-1b2c-4d5e-8f90-1234567890ab "
        "token eyJhbGciOiJIUzI1NiJ9.e30.sig4567890 gho_A1b2C3d4E5f6G7h8I9j0K1l2M3"
    )
    assert redact(text, "/home/test") == "read ~/.codex/auth.json for <email> id <id> token <token> <token>"


def test_long_field_names_are_not_mistaken_for_tokens() -> None:
    assert (
        redact("{cloud_session_storage_enabled: boolean}", "/home/test") == "{cloud_session_storage_enabled: boolean}"
    )


def test_reports_name_accounts_by_service_and_number() -> None:
    assert account_label("copilot", 1) == "copilot-1"
    report = format_report(
        [
            {
                "at": 1_794_303_000_000,
                "account": "copilot-1",
                "kind": "copilot",
                "app": "github-cli",
                "step": "response",
                "detail": "{quota_snapshots: {...}}",
            }
        ],
        {"version": "0.5.0", "date": "2026-11-10"},
    )
    assert report == (
        "Token Grill service 0.5.0 - 2026-11-10\n"
        "2026-11-10T09:30:00.000Z copilot-1 (copilot, github-cli) response: {quota_snapshots: {...}}\n"
    )


def test_a_request_is_recorded_as_its_method_host_and_path_never_the_query() -> None:
    assert (
        request_detail("GET", "https://api.deepseek.com/user/balance?key=sk-abc123")
        == "GET api.deepseek.com/user/balance"
    )
    assert (
        request_detail("POST", "https://oidc.us-east-1.amazonaws.com/token#x")
        == "POST oidc.us-east-1.amazonaws.com/token"
    )


def test_service_host_names_stay_readable() -> None:
    assert (
        redact("POST codewhisperer.us-east-1.amazonaws.com/ and oidc.eu-west-1.amazonaws.com/token", "/home/test")
        == "POST codewhisperer.us-east-1.amazonaws.com/ and oidc.eu-west-1.amazonaws.com/token"
    )
