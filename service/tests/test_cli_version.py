from tokengrill.cli import main


def test_version_prints_package_and_api(capsys):
    assert main(["version"]) == 0
    assert capsys.readouterr().out == "tokengrill 0.1.2 (D-Bus API 2)\n"


def test_unknown_command_fails():
    assert main(["nope"]) == 2
