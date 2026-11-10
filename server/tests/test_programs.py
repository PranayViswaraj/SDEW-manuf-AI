"""Programs API, versioning and approval (safety rules 2 and 3)."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import AuditLog, Machine, Program, ProgramSource, ProgramStatus
from app.seed import run_seed
from app.services.approval import approval_problem
from app.services.program_store import ProgramError, create_version
from tests.conftest import REPO_DIR

H = dict[str, dict[str, str]]
README_HASHES = {
    "O0001": "92e55218576f6beec6fb2b8e1949d5489d323905c7283e54e7cce50a44fbfef9",
    "O0002": "6452d4a4fbc761c7f22edae3d629f8872510c4e0a5a53d35310cb61aaba751d7",
    "O0003": "80723ed416f47eddc825d2bb3afb09e32e3e6257b4763a45987a9fc89920a43b",
    "O0004": "36d2cd18c9849f8255439b16fccf697c38d7de0cab0ee03c4ce386105a965a44",
    "O0009": "eeac3e1ef7951f0db138978ebf0ae85ebbe1d7dc6d350516826dcc73b59916f3",
}
GOOD = "%\nO1234(PART-77 BUSH)\nG28U0W0\nG97S1000M4\nT0101\nG0X20.0Z2.0\nG1Z-10.0F0.2\nM30\n%"


@pytest.fixture
def seeded(settings: Settings, db: Session) -> Machine:
    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-lathe-1"))
    assert m is not None
    return m


def upload(client: TestClient, h: H, machine_id: int, text: str = GOOD, **kw: Any) -> Any:
    return client.post(
        "/api/programs",
        headers=h["programmer"],
        json={"machine_id": machine_id, "text": text, **kw},
    )


def test_sample_files_unchanged() -> None:
    import hashlib

    for name, digest in README_HASHES.items():
        assert (
            hashlib.sha256((REPO_DIR / "samples" / "programs" / name).read_bytes()).hexdigest()
            == digest
        )


def test_trusted_programs_imported_as_approved(
    client: TestClient, role_headers: H, seeded: Machine, db: Session
) -> None:
    rows = client.get("/api/programs", headers=role_headers["operator"]).json()
    assert len(rows) == 5
    by_name = {r["name"]: r for r in rows}
    for name, digest in README_HASHES.items():
        r = by_name[name]
        assert r["status"] == "approved" and r["proven"] is True
        assert r["sha256"] == digest  # exact bytes, \r kept
        assert (
            r["source"] == "trusted_import" and r["source_note"] == "trusted, supplied by company"
        )
        assert r["machine_name"] == "LMW Lathe 1" and r["error_count"] == 0
    assert by_name["O0001"]["part_number"] == "3773480M01"
    detail = client.get(
        f"/api/programs/{by_name['O0004']['id']}", headers=role_headers["operator"]
    ).json()
    assert detail["sendable_problem"] is None
    assert detail["validation"]["ok"] is True
    assert "\r" not in "".join(detail["lines"]) and "\r" in detail["text"]


def test_trusted_import_is_idempotent(settings: Settings, db: Session, seeded: Machine) -> None:
    run_seed(settings, db)
    assert len(db.scalars(select(Program)).all()) == 5


def test_upload_creates_draft_and_validates(
    client: TestClient, role_headers: H, seeded: Machine
) -> None:
    r = upload(client, role_headers, seeded.id)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["status"] == "draft" and p["version"] == 1 and p["part_number"] == "PART-77"
    assert p["title"] == "BUSH" and p["sendable_problem"] is not None


def test_upload_rejects_bad_input(client: TestClient, role_headers: H, seeded: Machine) -> None:
    assert upload(client, role_headers, seeded.id, text="G0X1\nM30").status_code == 422
    assert (
        upload(client, role_headers, seeded.id, text=GOOD.replace("BUSH", "BÜSH")).status_code
        == 422
    )
    assert upload(client, role_headers, 999).status_code == 404


def test_approve_requires_no_errors(client: TestClient, role_headers: H, seeded: Machine) -> None:
    bad = GOOD.replace("G1Z", "G13Z")
    p = upload(client, role_headers, seeded.id, text=bad).json()
    r = client.post(f"/api/programs/{p['id']}/approve", headers=role_headers["programmer"])
    assert r.status_code == 422 and "validation error" in r.json()["detail"]


def test_approve_then_edit_creates_new_version_and_clears_approval(
    client: TestClient, role_headers: H, seeded: Machine, db: Session
) -> None:
    h = role_headers["programmer"]
    p1 = upload(client, role_headers, seeded.id).json()
    r = client.post(f"/api/programs/{p1['id']}/approve", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert r.json()["approved_hash"] == p1["sha256"] and r.json()["sendable_problem"] is None

    r = client.put(
        f"/api/programs/{p1['id']}/text", headers=h, json={"text": GOOD.replace("X20.0", "X21.0")}
    )
    assert r.status_code == 200
    p2 = r.json()
    assert p2["version"] == 2 and p2["status"] == "draft" and p2["sha256"] != p1["sha256"]
    old = client.get(f"/api/programs/{p1['id']}", headers=h).json()
    assert old["status"] == "retired" and "Superseded by version 2" in old["status_note"]
    assert old["sendable_problem"] is not None
    # identical text is not a change
    assert (
        client.put(
            f"/api/programs/{p2['id']}/text", headers=h, json={"text": p2["text"]}
        ).status_code
        == 422
    )
    # only the latest version can be approved
    assert client.post(f"/api/programs/{p1['id']}/approve", headers=h).status_code == 409
    actions = [a.action for a in db.scalars(select(AuditLog))]
    assert {"program_upload", "program_approve", "program_new_version"} <= set(actions)


def test_reject_and_retire(client: TestClient, role_headers: H, seeded: Machine) -> None:
    p = upload(client, role_headers, seeded.id).json()
    r = client.post(
        f"/api/programs/{p['id']}/reject",
        headers=role_headers["programmer"],
        json={"reason": "wrong feed"},
    )
    assert r.json()["status"] == "rejected" and r.json()["status_note"] == "wrong feed"
    r = client.post(f"/api/programs/{p['id']}/retire", headers=role_headers["admin"])
    assert r.json()["status"] == "retired"
    assert (
        client.post(
            f"/api/programs/{p['id']}/approve", headers=role_headers["programmer"]
        ).status_code
        == 409
    )


def test_approval_problem_rules(db: Session, seeded: Machine) -> None:
    p = db.scalars(select(Program).where(Program.program_number == 1)).one()
    assert approval_problem(db, p, seeded) is None
    other = Machine(key="other", name="Other Lathe")
    db.add(other)
    db.commit()
    assert "different machine" in (approval_problem(db, p, other) or "")
    p.text = p.text.replace("X50.0", "X51.0")  # tampered in the database
    assert "does not match its hash" in (approval_problem(db, p, seeded) or "")
    db.rollback()
    p.status = ProgramStatus.DRAFT.value
    assert "not approved" in (approval_problem(db, p, seeded) or "")
    db.rollback()


def test_program_sources_never_include_ai(db: Session, seeded: Machine) -> None:
    # Safety rule 2: there is no AI program source, and unknown sources are refused.
    assert not any("ai" in s.value.split("_") for s in ProgramSource)
    with pytest.raises(ProgramError):
        create_version(db, machine=seeded, text=GOOD, source="ai", user=None)  # type: ignore[arg-type]


def test_only_programmers_upload_and_approve(
    client: TestClient, role_headers: H, seeded: Machine
) -> None:
    body = {"machine_id": seeded.id, "text": GOOD}
    for who in ("admin", "engineer", "operator"):
        assert client.post("/api/programs", headers=role_headers[who], json=body).status_code == 403
