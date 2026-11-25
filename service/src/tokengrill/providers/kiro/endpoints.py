"""Request addresses of the Kiro regions."""

import re

from tokengrill.core.errors import ServiceError

# GetUsageLimits is served by the Amazon Q endpoint of these regions only.
SERVICE_HOSTS: dict[str, str] = {
    "us-east-1": "codewhisperer.us-east-1.amazonaws.com",
    "eu-central-1": "q.eu-central-1.amazonaws.com",
    "us-gov-east-1": "q.us-gov-east-1.amazonaws.com",
    "us-gov-west-1": "q.us-gov-west-1.amazonaws.com",
    "us-iso-east-1": "q.us-iso-east-1.c2s.ic.gov",
    "us-isob-east-1": "q.us-isob-east-1.sc2s.sgov.gov",
    "us-isof-south-1": "q.us-isof-south-1.csp.hci.ic.gov",
    "us-isof-east-1": "q.us-isof-east-1.csp.hci.ic.gov",
}

_REGION = re.compile(r"[a-z0-9-]+")


def is_kiro_service_region(region: str) -> bool:
    return region in SERVICE_HOSTS


def kiro_usage_url(region: str) -> str:
    host = SERVICE_HOSTS.get(region)
    if host is None:
        raise ServiceError("auth-invalid", "kiro.region-unsupported", name=region)
    return f"https://{host}/"


def kiro_oidc_endpoint(region: str) -> str:
    if _REGION.fullmatch(region) is None:
        raise ServiceError("auth-invalid", "kiro.region-invalid")
    return f"https://oidc.{region}.amazonaws.com/token"


def kiro_usage_request_body(profile_arn: str | None) -> dict[str, object]:
    """GetUsageLimits uses the AWS JSON protocol, which reads its parameters from the request body.
    Asking for the e-mail address lets the panel show which account kiro-cli is signed in to."""
    if profile_arn:
        return {"profileArn": profile_arn, "isEmailRequired": True}
    return {"isEmailRequired": True}
