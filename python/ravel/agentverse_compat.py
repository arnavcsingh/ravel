"""Narrow compatibility fix for agentverse-sdk 0.2.1 initial onboarding.

The SDK reads a stored listing before registering. A new, already-issued agent
URI has no stored listing yet. Treat only that GET's 404 as an empty listing,
then let the SDK perform and validate its normal signed registration POST.
No identity is generated and no successful registration is simulated.
"""


def enable_first_registration():
    from agentverse_sdk._common import av
    from requests import HTTPError
    original = av._get_stored_listing_sync
    if getattr(original, "_ravel_compat", False) is True:
        return

    def listing(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except HTTPError as error:
            if error.response is not None and error.response.status_code == 404:
                return av._StoredListing()
            raise
    listing._ravel_compat = True
    av._get_stored_listing_sync = listing
    original_post = av._post_data_sync

    def register_post(*args, **kwargs):
        try:
            return original_post(*args, **kwargs)
        except HTTPError as error:
            if error.response is not None:
                try:
                    detail = error.response.json().get("detail", "Registration rejected")
                except (ValueError, AttributeError):
                    detail = "Registration rejected"
                # Only known diagnostics are safe to expose; never echo bodies.
                known = {"Agent not found", "User not found", "Not authenticated", "Invalid signature"}
                message = detail if isinstance(detail, str) and detail in known else "Registration rejected"
                raise RuntimeError(f"Agentverse registration HTTP {error.response.status_code}: {message}") from None
            raise
    av._post_data_sync = register_post
