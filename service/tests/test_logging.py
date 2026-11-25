import logging

import pytest

from tokengrill.service import configure_logging


def test_service_loggers_reach_stderr_at_info_and_http_library_loggers_do_not(
    capsys: pytest.CaptureFixture[str],
) -> None:
    logger = logging.getLogger("tokengrill")
    saved = (list(logger.handlers), logger.level, logger.propagate)
    logger.handlers.clear()
    try:
        configure_logging()
        configure_logging()
        logging.getLogger("tokengrill.runtime").info("codex-1 (codex-cli) request: GET x")
        logging.getLogger("httpx").info("HTTP Request: GET https://x/?key=secret")
        err = capsys.readouterr().err
        assert err.count("codex-1 (codex-cli) request: GET x") == 1
        assert "secret" not in err
    finally:
        logger.handlers[:] = saved[0]
        logger.setLevel(saved[1])
        logger.propagate = saved[2]
