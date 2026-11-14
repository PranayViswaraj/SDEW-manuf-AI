"""Role checks on EVERY endpoint.

`ROUTE_ROLES` must list every HTTP route in the app. Adding a route without adding it here
fails `test_every_route_is_declared`, so no endpoint can ship without a declared role rule.
"""

import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PUBLIC = "public"
ANY_USER = "any"
A, E, P, O = "admin", "engineer", "programmer", "operator"

# (method, path) -> PUBLIC | ANY_USER | set of roles allowed
ROUTE_ROLES: dict[tuple[str, str], str | set[str]] = {
    ("GET", "/api/health"): PUBLIC,
    ("GET", "/api/ready"): PUBLIC,
    ("POST", "/api/auth/login"): PUBLIC,
    ("GET", "/api/auth/me"): ANY_USER,
    ("GET", "/api/users"): {A},
    ("POST", "/api/users"): {A},
    ("PATCH", "/api/users/{user_id}"): {A},
    ("GET", "/api/audit-log"): {A},
    ("GET", "/api/machines"): ANY_USER,
    ("POST", "/api/machines"): {A},
    ("GET", "/api/machines/{machine_id}"): ANY_USER,
    ("PATCH", "/api/machines/{machine_id}"): {A},
    ("DELETE", "/api/machines/{machine_id}"): {A},
    ("GET", "/api/machines/{machine_id}/tools"): ANY_USER,
    ("POST", "/api/machines/{machine_id}/tools"): {A, P},
    ("PUT", "/api/machines/{machine_id}/tools/{tool_id}"): {A, P},
    ("DELETE", "/api/machines/{machine_id}/tools/{tool_id}"): {A, P},
    ("GET", "/api/materials"): ANY_USER,
    ("POST", "/api/materials"): {A, E},
    ("PUT", "/api/materials/{material_id}"): {A, E},
    ("DELETE", "/api/materials/{material_id}"): {A, E},
    ("POST", "/api/materials/import/preview"): {A, E},
    ("POST", "/api/materials/import"): {A, E},
    ("GET", "/api/machines/{machine_id}/live"): ANY_USER,
    ("GET", "/api/bridges"): {A},
    ("POST", "/api/bridges"): {A},
    ("GET", "/api/programs"): ANY_USER,
    ("POST", "/api/programs"): {P},
    ("GET", "/api/programs/{program_id}"): ANY_USER,
    ("GET", "/api/programs/{program_id}/toolpath"): ANY_USER,
    ("GET", "/api/programs/{program_id}/file"): ANY_USER,
    ("PUT", "/api/programs/{program_id}/text"): {P},
    ("POST", "/api/programs/{program_id}/approve"): {P, E},
    ("POST", "/api/programs/{program_id}/reject"): {P},
    ("POST", "/api/programs/{program_id}/retire"): {P, A},
    ("GET", "/api/drawings"): ANY_USER,
    ("GET", "/api/drawings/known"): ANY_USER,
    ("POST", "/api/drawings/identify"): {E, P},
    ("POST", "/api/drawings"): {E, P},
    ("GET", "/api/drawings/{drawing_id}/file"): ANY_USER,
    ("GET", "/api/generator/plan"): ANY_USER,
    ("POST", "/api/generator/preview"): ANY_USER,
    ("POST", "/api/generator/programs"): {P, E},
    ("GET", "/api/generator/library"): ANY_USER,
    ("POST", "/api/generator/library/{name}/use"): {P, E},
    ("GET", "/api/runs"): ANY_USER,
    ("POST", "/api/runs"): {O},
    ("GET", "/api/runs/{run_id}"): ANY_USER,
    ("PUT", "/api/runs/{run_id}/checklist"): {O},
    ("PUT", "/api/runs/{run_id}/material"): {O},
    ("POST", "/api/runs/{run_id}/abort"): {O},
    ("POST", "/api/runs/{run_id}/send"): {O},
    ("POST", "/api/runs/{run_id}/start"): {O},
    ("POST", "/api/runs/{run_id}/feed-hold"): {O},
    ("POST", "/api/runs/{run_id}/stop"): {O},
    ("POST", "/api/runs/{run_id}/first-piece"): {O},
    ("GET", "/api/feature-tables/schema"): ANY_USER,
    ("GET", "/api/feature-tables"): ANY_USER,
    ("POST", "/api/feature-tables"): {E},
    ("POST", "/api/feature-tables/from-drawing"): {E},
    ("GET", "/api/feature-tables/{table_id}"): ANY_USER,
    ("PUT", "/api/feature-tables/{table_id}"): {E},
    ("POST", "/api/feature-tables/{table_id}/confirm"): {E},
    ("GET", "/api/capability"): ANY_USER,
}

ALL_ROLES = (A, E, P, O)


def _api_routes(app: FastAPI) -> list[tuple[str, str]]:
    """All HTTP routes, from the OpenAPI schema (no route may hide with include_in_schema)."""
    out = []
    for path, ops in app.openapi()["paths"].items():
        if path.startswith("/api"):
            out += [
                (m.upper(), path) for m in ops if m in ("get", "post", "put", "patch", "delete")
            ]
    return sorted(out)


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def test_every_route_is_declared(app: FastAPI) -> None:
    missing = set(_api_routes(app)) - set(ROUTE_ROLES)
    assert not missing, f"Declare role rules for new routes in ROUTE_ROLES: {sorted(missing)}"
    stale = set(ROUTE_ROLES) - set(_api_routes(app))
    assert not stale, f"ROUTE_ROLES lists routes that no longer exist: {sorted(stale)}"


@pytest.mark.parametrize(("method", "path"), sorted(ROUTE_ROLES))
def test_route_requires_login(client: TestClient, method: str, path: str) -> None:
    if ROUTE_ROLES[(method, path)] == PUBLIC:
        pytest.skip("public route")
    r = client.request(method, _concrete(path), json={})
    assert r.status_code == 401, f"{method} {path} must require login"


@pytest.mark.parametrize(("method", "path"), sorted(ROUTE_ROLES))
def test_route_role_rules(
    client: TestClient, role_headers: dict[str, dict[str, str]], method: str, path: str
) -> None:
    rule = ROUTE_ROLES[(method, path)]
    if rule == PUBLIC:
        pytest.skip("public route")
    for who in (*ALL_ROLES, "none"):
        r = client.request(method, _concrete(path), headers=role_headers[who], json={})
        allowed = rule == ANY_USER or (isinstance(rule, set) and who in rule)
        if allowed:
            assert r.status_code not in (401, 403), f"{who} should be allowed: {method} {path}"
        else:
            assert r.status_code == 403, f"{who} must be refused: {method} {path}"
            assert "role" in r.json()["detail"]
