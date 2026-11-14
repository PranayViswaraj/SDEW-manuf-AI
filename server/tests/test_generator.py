"""Drawing-to-program: deterministic generator, proven-program data, drawings, API flow."""

import ast
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import AuditLog, FeatureTable, Machine, Program, Role, Tool
from app.gcode.backplot import backplot
from app.gcode.generator import ToolInfo, fmt, generate, read_geometry
from app.gcode.proven_data import clearance, extract, proven_data, spindle_direction
from app.gcode.validator import MachineContext, validate
from app.seed import seed_demo_lmw
from app.services.feature_tables import data_hash
from tests.conftest import UserFactory, headers_for

REPO = Path(__file__).resolve().parents[2]


def cell(v: Any) -> dict[str, Any]:
    return {"ai": None, "value": v, "confirmed": True}


def feat(t: str, **kw: Any) -> dict[str, Any]:
    return {"type": t, "fields": {k: cell(v) for k, v in kw.items()}}


def sleeve() -> dict[str, Any]:
    return {
        "header": {
            "material_grade": cell("EN8"),
            "bar_diameter": cell(50.0),
            "overall_length": cell(40.0),
        },
        "features": [
            feat("face", position=0.0, tol_plus=0.0, tol_minus=-0.1),
            feat("drill", diameter=20.0, depth=45.0, tol_plus=0.1, tol_minus=0.0),
            feat("chamfer", size=1.0, angle=45.0, tol_plus=0.0, tol_minus=0.0),
            feat("od", diameter=30.0, length=15.0, tol_plus=0.0, tol_minus=-0.05),
            feat("radius", radius=0.5, tol_plus=0.0, tol_minus=0.0),
            feat("od", diameter=45.0, length=25.0, tol_plus=0.0, tol_minus=-0.05),
            feat("chamfer", size=0.5, angle=45.0, tol_plus=0.0, tol_minus=0.0),
            feat("bore", diameter=26.0, depth=10.0, tol_plus=0.05, tol_minus=0.0),
            feat("bore", diameter=22.0, depth=30.0, tol_plus=0.05, tol_minus=0.0),
            feat("groove", diameter=27.0, width=4.0, position=11.0, tol_plus=0.0, tol_minus=-0.1),
            feat("thread", size="M30", pitch=1.5, length=10.0, tol_class="6g"),
        ],
    }


TOOLS = [
    ToolInfo("T0101", "drill", "20 U DRILL", None),
    ToolInfo("T0202", "od_rough", "WNMG 0.8 RG", 0.8),
    ToolInfo("T0303", "od_finish", "TNMG 0.4 FIN", 0.4),
    ToolInfo("T0404", "parting", "3MM PARTING", None),
    ToolInfo("T0505", "bore", "BORE FIN", 0.4),
    ToolInfo("T0606", "groove", "3MM GROOVING", None),
    ToolInfo("T0707", "thread", "THREAD", None),
]


def setup() -> dict[str, dict[str, Any]]:
    return {
        "general": {"clearance": 2.0, "spindle_direction": "M4", "part_off": "yes"},
        "drill": {"tool_code": "T0101", "rpm": 800, "feed": 0.05, "peck": 5.0, "retract": 1.0},
        "rough": {
            "tool_code": "T0202",
            "rpm": 1800,
            "feed": 0.2,
            "depth_of_cut": 1.0,
            "retract": 0.5,
            "finish_allow_x": 0.4,
            "finish_allow_z": 0.0,
            "face_stock": 1.0,
        },
        "finish": {"tool_code": "T0303", "rpm": 2500, "feed": 0.15},
        "bore": {
            "tool_code": "T0505",
            "rpm": 2000,
            "feed": 0.15,
            "finish_feed": 0.12,
            "depth_of_cut": 0.8,
            "retract": 0.5,
            "finish_allow_x": 0.3,
            "finish_allow_z": 0.0,
        },
        "groove": {
            "tool_code": "T0606",
            "rpm": 1200,
            "feed": 0.05,
            "width": 3.0,
            "ref_edge": "left",
        },
        "thread": {
            "tool_code": "T0707",
            "rpm": 800,
            "first_depth": 0.3,
            "min_depth": 0.05,
            "finish_allowance": 0.05,
            "finish_passes": 1,
        },
        "part": {"tool_code": "T0404", "rpm": 1000, "feed": 0.05, "width": 3.0, "ref_edge": "left"},
    }


def gen(data: dict[str, Any] | None = None, s: dict[str, Any] | None = None, **kw: Any) -> Any:
    return generate(
        data or sleeve(),
        program_number=kw.get("program_number", 1001),
        part_number="TEST-1",
        title="SLEEVE",
        setup=s if s is not None else setup(),
        tools=kw.get("tools", TOOLS),
        rpm_max=kw.get("rpm_max", 3000),
    )


# ------------------------------------------------------------------ generator


def test_full_sleeve_program_is_valid_and_plots() -> None:
    r = gen()
    assert r.problems == [] and r.text
    lines = r.text.splitlines()
    assert lines[0] == "%" and lines[1] == "O1001(TEST-1 SLEEVE)" and lines[-1] == "%"
    v = validate(r.text, MachineContext({t.tool_code for t in TOOLS}, None, 3000))
    assert v.errors == [] and v.warnings == []
    plot = backplot(r.text).to_dict(stock=None)
    assert plot["warnings"] == []
    assert plot["bounds"]["z_min"] == -45.0  # drill depth
    assert [op["key"] for op in r.operations] == [
        "drill",
        "rough",
        "finish",
        "bore",
        "groove",
        "thread",
        "part",
    ]


def test_geometry_values_are_exact() -> None:
    text = gen().text
    # diameters are cut at the middle of their tolerance, as the proven programs do:
    # OD 30 (0/-0.05) -> 29.975, OD 45 (0/-0.05) -> 44.975, bore 26 (+0.05/0) -> 26.025.
    # chamfer 1x45 on OD30, radius 0.5 on OD45, entry chamfer 0.5x45 on bore 26
    for line in (
        "N100G0X27.975",
        "G1X29.975Z-1.0",
        "G3X44.975Z-15.5R0.5",
        "N300G0X27.025",
        "G1X26.025Z-0.5",
    ):
        assert line in text.splitlines()
    # M30x1.5: ISO depth 0.61343*1.5 = 0.920 -> minor 28.16
    assert "G76X28.16Z-10.0P920Q300F1.5" in text
    # groove 4 wide at 11 with a 3 mm insert (left edge): 2 plunges covering Z-11..-15
    assert "G0Z-14.0" in text and "G0Z-15.0" in text
    # part off a 40 long part with a 3 mm blade set on its left edge
    assert "G0Z-43.0" in text
    # facing past the drilled hole by the nose radius
    assert "G1X18.4F0.2" in text


def test_same_inputs_same_program() -> None:
    assert gen().text == gen().text


def test_generator_has_no_ai_and_no_randomness() -> None:
    path = REPO / "server" / "app" / "gcode" / "generator.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imported = {
        (n.module or "") if isinstance(n, ast.ImportFrom) else a.name
        for n in ast.walk(tree)
        if isinstance(n, ast.Import | ast.ImportFrom)
        for a in (n.names if isinstance(n, ast.Import) else [n])  # type: ignore[attr-defined]
    }
    assert not any(m.startswith(("app.ai", "random", "time", "datetime")) for m in imported)


def test_every_missing_setup_value_is_reported_never_guessed() -> None:
    s = setup()
    del s["rough"]["face_stock"]
    s["finish"]["rpm"] = ""
    del s["general"]["part_off"]
    r = gen(s=s)
    assert r.text is None
    assert "Face and rough turn (G71): Stock on the front face not entered." in r.problems
    assert "Finish turn (G70): Spindle speed (G97) not entered." in r.problems
    assert any("Part off" in p for p in r.problems)


def test_missing_table_value_is_reported() -> None:
    data = sleeve()
    data["header"]["bar_diameter"] = cell(None)
    r = gen(data)
    assert r.text is None and "Bar diameter: not entered." in r.problems


def test_tool_must_be_on_the_machine_and_the_right_type() -> None:
    s = setup()
    s["finish"]["tool_code"] = "T0909"
    s["drill"]["tool_code"] = "T0202"
    r = gen(s=s)
    assert any("T0909 is not in this machine's tool list" in p for p in r.problems)
    assert any("T0202 is a 'od_rough' tool" in p for p in r.problems)


def test_rpm_above_machine_maximum_is_refused() -> None:
    r = gen(rpm_max=2000)
    assert any("2500 rpm is above the machine maximum" in p for p in r.problems)


def test_od_must_grow_towards_the_chuck() -> None:
    data = sleeve()
    data["features"][5]["fields"]["diameter"] = cell(28.0)
    _, problems = read_geometry(data)
    assert any("not bigger than the step before" in p for p in problems)


def test_groove_insert_wider_than_groove_is_refused() -> None:
    s = setup()
    s["groove"]["width"] = 5.0
    assert any("wider than the" in p for p in gen(s=s).problems)


def test_simple_shaft_without_bore_or_part_off() -> None:
    data = {
        "header": {
            "material_grade": cell("EN8"),
            "bar_diameter": cell(40.0),
            "overall_length": cell(30.0),
        },
        "features": [
            feat("od", diameter=20.0, length=10.0),
            feat("od", diameter=35.0, length=20.0),
        ],
    }
    s = setup()
    s["general"]["part_off"] = "no"
    # a cut blank turned over its full length would run into the chuck jaws: refused
    r = gen(data, s)
    assert any("Cut blank" in x for x in r.problems)
    # from bar, with a part-off, the same shaft is fine
    s["general"]["part_off"] = "yes"
    r = gen(data, s)
    assert r.problems == []
    assert [o["key"] for o in r.operations] == ["rough", "finish", "part"]
    assert "G1X-1.6F0.2" in r.text  # face past centre by the 0.8 nose radius


def test_fmt_always_has_a_decimal_point() -> None:
    assert [fmt(v) for v in (45.2, 0, -0.0, -31, 0.0004, 1.23456)] == [
        "45.2",
        "0.0",
        "0.0",
        "-31.0",
        "0.0",
        "1.235",
    ]


# ------------------------------------------------------------------ proven programs


def _trusted() -> list[tuple[str, int | None, str]]:
    folder = REPO / "samples" / "programs"
    return [(p.name, None, p.read_bytes().decode()) for p in sorted(folder.glob("O0*"))]


def test_values_read_from_proven_programs_with_their_source() -> None:
    pd = proven_data(_trusted())
    rough = pd.suggest(("od_rough",), "depth_of_cut")
    assert rough and rough["value"] == 1.0 and "O0004 line 30" in rough["note"]
    peck = pd.suggest(("drill",), "peck")
    assert peck and peck["value"] in (3.0, 5.0)
    width = pd.suggest(("parting",), "width")
    assert width and width["value"] == 3.0 and "O0001 line 75" in width["note"]
    assert pd.suggest(("thread",), "rpm") is None  # no proven thread: never invented
    c = clearance(pd.blocks)
    assert c and c.value == 2.0
    d = spindle_direction(pd.blocks)
    assert d and d.value == "M4"


def test_tool_kind_comes_from_the_comment_not_the_t_code() -> None:
    pd = proven_data(_trusted())
    kinds = {(b.program, b.tool_code, b.comment): b.kind for b in pd.blocks}
    assert kinds[("O0001", "T0101", "32.0 UDRILL")] == "drill"
    assert kinds[("O0002", "T0101", "STOPPER")] == "stopper"
    assert kinds[("O0003", "T0101", "BORE FIN 12MM CCMT")] == "bore"
    o4 = next(b for b in pd.blocks if b.program == "O0004" and b.comment == "WMNG FACEING ROUGH")
    assert extract(o4)["retract"].value == 0.5


# ------------------------------------------------------------------ API


@pytest.fixture
def lmw(settings: Settings, db: Session) -> Machine:
    seed_demo_lmw(db, settings)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-lathe-1"))
    assert m is not None
    for i, t in enumerate(TOOLS, start=1):
        db.add(
            Tool(
                machine_id=m.id,
                station=i,
                tool_code=t.tool_code,
                description=t.description,
                nose_radius=t.nose_radius,
                tool_type=t.tool_type,
            )
        )
    db.commit()
    return m


def _table(db: Session, confirmed: bool = True) -> FeatureTable:
    data = sleeve()
    ft = FeatureTable(
        part_number="TEST-1",
        drawing_ref="test.pdf",
        source="manual",
        data=data,
        status="confirmed" if confirmed else "draft",
        confirmed_hash=data_hash(data) if confirmed else None,
    )
    db.add(ft)
    db.commit()
    return ft


def test_plan_prefills_from_proven_programs(
    client: TestClient, db: Session, lmw: Machine, make_user: UserFactory
) -> None:
    ft = _table(db)
    h = headers_for(make_user(Role.PROGRAMMER))
    r = client.get(f"/api/generator/plan?feature_table_id={ft.id}&machine_id={lmw.id}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proven_programs"] == ["O0001", "O0002", "O0003", "O0004", "O0009"]
    ops = {o["key"]: o for o in body["operations"]}
    assert ops["thread"]["needed"] and ops["bore"]["needed"]
    gen_params = {p["key"]: p["suggestion"] for p in ops["general"]["params"]}
    assert gen_params["clearance"]["value"] == 2.0
    assert gen_params["part_off"] is None  # bar or blanks: open item, never assumed
    assert ops["drill"]["tool_suggestion"]["value"] == "T0101"
    thread = {p["key"]: p["suggestion"] for p in ops["thread"]["params"]}
    assert thread["first_depth"] is None  # no proven thread program


def test_preview_save_approve_flow(
    client: TestClient, db: Session, lmw: Machine, make_user: UserFactory
) -> None:
    ft = _table(db)
    prog = headers_for(make_user(Role.PROGRAMMER))
    body = {
        "feature_table_id": ft.id,
        "machine_id": lmw.id,
        "program_number": 1001,
        "title": "SLEEVE",
        "setup": setup(),
    }
    r = client.post("/api/generator/preview", json=body, headers=prog)
    assert r.status_code == 200 and r.json()["ok"], r.text
    assert r.json()["validation"]["ok"] is True
    assert r.json()["toolpath"]["segments"]

    r = client.post("/api/generator/programs", json=body, headers=prog)
    assert r.status_code == 201, r.text
    p = db.get(Program, r.json()["program_id"])
    assert p is not None and p.status == "draft" and p.source == "generator"
    assert p.part_number == "TEST-1"
    db.refresh(lmw)
    assert lmw.generator_defaults["finish"]["rpm"] == 2500
    assert db.scalar(select(AuditLog).where(AuditLog.action == "program_generate"))

    # the next plan offers the saved setup first
    plan = client.get(
        f"/api/generator/plan?feature_table_id={ft.id}&machine_id={lmw.id}", headers=prog
    ).json()
    general = next(o for o in plan["operations"] if o["key"] == "general")
    part_off = next(x for x in general["params"] if x["key"] == "part_off")["suggestion"]
    assert part_off["value"] == "yes" and part_off["source"] == "last saved"

    r = client.post(f"/api/programs/{p.id}/approve", headers=prog)
    assert r.status_code == 200 and r.json()["status"] == "approved"


def test_save_refuses_unconfirmed_table(
    client: TestClient, db: Session, lmw: Machine, make_user: UserFactory
) -> None:
    ft = _table(db, confirmed=False)
    body = {
        "feature_table_id": ft.id,
        "machine_id": lmw.id,
        "program_number": 1001,
        "setup": setup(),
    }
    h = headers_for(make_user(Role.PROGRAMMER))
    assert client.post("/api/generator/preview", json=body, headers=h).json()["table_problem"]
    r = client.post("/api/generator/programs", json=body, headers=h)
    assert r.status_code == 409 and "not confirmed" in r.json()["detail"]


def test_save_refuses_a_number_used_by_another_part(
    client: TestClient, db: Session, lmw: Machine, make_user: UserFactory
) -> None:
    ft = _table(db)
    body = {"feature_table_id": ft.id, "machine_id": lmw.id, "program_number": 1, "setup": setup()}
    r = client.post(
        "/api/generator/programs", json=body, headers=headers_for(make_user(Role.PROGRAMMER))
    )
    assert (
        r.status_code == 409 and "O0001 is already used for part 3773480M01" in r.json()["detail"]
    )


# ------------------------------------------------------------------ drawings

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def test_upload_and_view_drawing(client: TestClient, make_user: UserFactory) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    r = client.post(
        "/api/drawings",
        data={"part_number": "TEST-1"},
        files={"file": ("part.pdf", PDF, "application/octet-stream")},
        headers=eng,
    )
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["content_type"] == "application/pdf" and d["size"] == len(PDF)
    listed = client.get("/api/drawings?part_number=TEST-1", headers=eng).json()
    assert [x["id"] for x in listed] == [d["id"]]
    f = client.get(f"/api/drawings/{d['id']}/file", headers=eng)
    assert f.status_code == 200 and f.content == PDF
    assert f.headers["content-type"] == "application/pdf"
    assert f.headers["x-content-type-options"] == "nosniff"


def test_drawing_type_comes_from_the_bytes(client: TestClient, make_user: UserFactory) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    r = client.post(
        "/api/drawings",
        data={"part_number": "X"},
        files={"file": ("evil.pdf", b"MZ\x90\x00not a pdf", "application/pdf")},
        headers=eng,
    )
    assert r.status_code == 415


# ------------------------------------------------------------------ company library, real machines


def test_library_matches_the_drawing_part_number(
    client: TestClient, make_user: UserFactory
) -> None:
    h = headers_for(make_user(Role.ENGINEER))
    r = client.get("/api/generator/library?part_number=3773480M01", headers=h)
    assert [p["name"] for p in r.json()] == ["O0001"]
    # header "1816C01001&1527A02301" names two parts: either matches
    r = client.get("/api/generator/library?part_number=1527a02301", headers=h)
    assert [p["name"] for p in r.json()] == ["O0002"]
    assert client.get("/api/generator/library?part_number=NOPE", headers=h).json() == []


def test_real_machines_refuse_programs_until_the_control_is_confirmed(
    client: TestClient, settings: Settings, db: Session, make_user: UserFactory
) -> None:
    from app.seed import run_seed

    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-lx20tl3-l110-00542"))
    assert m is not None and m.controller == "FANUC 0i-TF"  # confirmed for all lathes
    m.controller = ""  # a machine whose control is not entered must still be refused
    db.commit()
    h = headers_for(make_user(Role.PROGRAMMER))
    body = {"machine_id": m.id, "part_number": "3773480M01"}
    r = client.post("/api/generator/library/O0001/use", json=body, headers=h)
    assert r.status_code == 409 and "control of" in r.json()["detail"]

    m.controller = "FANUC 0i-TF"  # entered after checking at the machine
    db.commit()
    r = client.post("/api/generator/library/O0001/use", json=body, headers=h)
    assert r.status_code == 201, r.text
    p = db.get(Program, r.json()["program_id"])
    assert p is not None and p.status == "draft" and p.machine_id == m.id
    lib = (REPO / "samples" / "programs" / "O0001").read_bytes().decode("ascii")
    assert p.text == lib  # byte for byte
    # asking again does not duplicate it
    again = client.post("/api/generator/library/O0001/use", json=body, headers=h)
    assert again.json()["program_id"] == p.id


def test_library_program_must_be_for_that_part(
    client: TestClient, db: Session, lmw: Machine, make_user: UserFactory
) -> None:
    h = headers_for(make_user(Role.PROGRAMMER))
    body = {"machine_id": lmw.id, "part_number": "OTHER-PART"}
    r = client.post("/api/generator/library/O0001/use", json=body, headers=h)
    assert r.status_code == 422


def test_send_is_blocked_while_the_control_is_not_confirmed(db: Session, lmw: Machine) -> None:
    from app.services.approval import approval_problem

    p = db.scalar(select(Program).where(Program.machine_id == lmw.id))
    assert p is not None and approval_problem(db, p, lmw) is None
    lmw.controller = ""
    assert "not confirmed" in (approval_problem(db, p, lmw) or "")


# ------------------------------------------------------------------ known drawings (autofill)

DRAWING_3773480M01 = next(
    (
        f
        for f in (
            REPO.parent / "drawings" / "3773480M01 SLEEVE 4WD.pdf",
            REPO.parent / "3773480M01 SLEEVE 4WD.pdf",
        )
        if f.is_file()
    ),
    REPO.parent / "3773480M01 SLEEVE 4WD.pdf",
)


def _upload(client: TestClient, h: dict[str, str], part: str, content: bytes) -> Any:
    return client.post(
        "/api/drawings",
        data={"part_number": part},
        files={"file": ("d.pdf", content, "application/pdf")},
        headers=h,
    )


def _empty_table(client: TestClient, h: dict[str, str], part: str) -> int:
    r = client.post("/api/feature-tables", json={"part_number": part}, headers=h)
    assert r.status_code == 201, r.text
    return int(r.json()["id"])


def test_known_part_is_filled_but_not_confirmed(client: TestClient, make_user: UserFactory) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    tid = _empty_table(client, eng, "3773480M01")
    r = _upload(client, eng, "3773480M01", PDF)  # any file: matched by part number
    assert r.status_code == 201 and r.json()["autofill"]["filled"] is True
    t = client.get(f"/api/feature-tables/{tid}", headers=eng).json()
    assert t["status"] == "draft" and t["source"] == "known_drawing"
    od = next(f for f in t["data"]["features"] if f["type"] == "od")["fields"]
    assert od["diameter"] == {"ai": 44.45, "value": 44.45, "confirmed": False}
    # not on the drawing: worked out from O0001 (between 45.2 and 50), filled but not ticked
    bar = t["data"]["header"]["bar_diameter"]
    assert bar["value"] == 48.0 and bar["confirmed"] is False
    cells = [c for f in t["data"]["features"] for c in f["fields"].values()]
    assert not any(c["confirmed"] for c in cells)  # the engineer still ticks every value
    info = client.get("/api/drawings/known?part_number=3773480m01", headers=eng).json()
    assert any("BACK end" in x for x in info["not_in_table"])


def test_autofill_never_overwrites_entered_values(
    client: TestClient, make_user: UserFactory
) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    tid = _empty_table(client, eng, "3773480M01")
    t = client.get(f"/api/feature-tables/{tid}", headers=eng).json()
    t["data"]["header"]["overall_length"]["value"] = 24.0
    client.put(f"/api/feature-tables/{tid}", json={"data": t["data"]}, headers=eng)
    r = _upload(client, eng, "3773480M01", PDF)
    assert r.json()["autofill"]["filled"] is False
    t = client.get(f"/api/feature-tables/{tid}", headers=eng).json()
    assert t["data"]["header"]["overall_length"]["value"] == 24.0


def test_unknown_drawing_fills_nothing(client: TestClient, make_user: UserFactory) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    _empty_table(client, eng, "NEW-PART")
    r = _upload(client, eng, "NEW-PART", PDF)
    assert r.json()["autofill"] is None


@pytest.mark.skipif(not DRAWING_3773480M01.is_file(), reason="drawing file not on this PC")
def test_real_drawing_file_is_recognised_under_another_part_number(
    client: TestClient, make_user: UserFactory
) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    _empty_table(client, eng, "TYPO-123")
    r = _upload(client, eng, "TYPO-123", DRAWING_3773480M01.read_bytes())
    info = r.json()["autofill"]
    assert info["filled"] is False and "drawing of part 3773480M01" in info["message"]
    # uploading the same file twice keeps one copy
    again = _upload(client, eng, "TYPO-123", DRAWING_3773480M01.read_bytes())
    assert again.json()["id"] == r.json()["id"]


def _setup_from_plan(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for op in plan["operations"]:
        row: dict[str, Any] = {}
        if op["tool_suggestion"]:
            row["tool_code"] = op["tool_suggestion"]["value"]
        for prm in op["params"]:
            if prm["suggestion"]:
                row[prm["key"]] = prm["suggestion"]["value"]
        out[op["key"]] = row
    return out


def test_3773480m01_generates_with_no_questions_on_a_real_machine(
    client: TestClient, settings: Settings, db: Session, make_user: UserFactory
) -> None:
    """Drawing values (bar size left empty) + O0001 for this part: nothing left to ask."""
    from app.ai.known_drawings import find_known, load_known
    from app.seed import run_seed

    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-lx20tl3-l110-00542"))
    assert m is not None and not m.tools  # real machine, nothing entered yet
    known = find_known(
        load_known(REPO / "samples" / "drawings" / "known_drawings.json"), part_number="3773480M01"
    )
    assert known is not None
    ft = FeatureTable(part_number="3773480M01", data=known.table_data(), status="draft")
    db.add(ft)
    db.commit()
    h = headers_for(make_user(Role.PROGRAMMER))
    plan = client.get(
        f"/api/generator/plan?feature_table_id={ft.id}&machine_id={m.id}", headers=h
    ).json()
    assert plan["geometry_problems"] == []
    missing = [
        f"{o['key']}.{p['key']}"
        for o in plan["operations"]
        if o["needed"]
        for p in o["params"]
        if p["suggestion"] is None
    ]
    assert missing == []
    body = {
        "feature_table_id": ft.id,
        "machine_id": m.id,
        "program_number": plan["program_number"],
        "setup": _setup_from_plan(plan),
    }
    r = client.post("/api/generator/preview", json=body, headers=h).json()
    assert r["ok"], r["problems"]
    assert r["validation"]["errors"] == []
    text = r["text"]
    assert "T0101" in text and "G74Z-31.0Q5000F0.05" in text  # O0001's U-drill
    assert "G1X44.4Z-2.0" in text  # drawing OD 44.45 0/-0.1, cut at its middle 44.40
    assert "G0Z-26.0" in text  # 23 long, 3 mm blade set on its left edge
    assert "BAR D48.0" in text  # bar size worked out from O0001
    assert r["controller_problem"] is None  # FANUC 0i-TF, confirmed for all lathes


def test_upload_refuses_a_drawing_named_for_another_part(
    client: TestClient, make_user: UserFactory
) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    _empty_table(client, eng, "3773480M01")
    r = client.post(
        "/api/drawings",
        data={"part_number": "3773480M01"},
        files={"file": ("1627C00501 SLEEVE.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    assert r.status_code == 409 and "is for part 1627C00501" in r.json()["detail"]
    ok = client.post(
        "/api/drawings",
        data={"part_number": "3773480M01"},
        files={"file": ("3773480M01 SLEEVE 4WD.pdf", PDF, "application/pdf")},
        headers=eng,
    )
    assert ok.status_code == 201


KNOWN_JSON = REPO / "samples" / "drawings" / "known_drawings.json"


def _plan_and_preview(
    client: TestClient, db: Session, h: dict[str, str], part: str, machine: Machine
) -> tuple[dict[str, Any], dict[str, Any]]:
    from app.ai.known_drawings import find_known, load_known

    k = find_known(load_known(KNOWN_JSON), part_number=part)
    assert k is not None
    ft = FeatureTable(part_number=k.part_number, data=k.table_data(), status="draft")
    db.add(ft)
    db.commit()
    plan = client.get(
        f"/api/generator/plan?feature_table_id={ft.id}&machine_id={machine.id}", headers=h
    ).json()
    body = {
        "feature_table_id": ft.id,
        "machine_id": machine.id,
        "program_number": 1000,
        "setup": _setup_from_plan(plan),
    }
    return plan, client.post("/api/generator/preview", json=body, headers=h).json()


@pytest.mark.parametrize(
    "part", ["3773480M01", "1816C01001", "1627C00501", "3216C11701", "832100172"]
)
def test_every_known_lathe_drawing_generates_with_nothing_to_ask(
    client: TestClient, settings: Settings, db: Session, make_user: UserFactory, part: str
) -> None:
    from app.seed import run_seed

    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-smarturn-55-04927"))
    assert m is not None
    plan, r = _plan_and_preview(client, db, headers_for(make_user(Role.PROGRAMMER)), part, m)
    assert plan["geometry_problems"] == []
    part_off = next(
        p["suggestion"]["value"]
        for o in plan["operations"]
        if o["key"] == "general"
        for p in o["params"]
        if p["key"] == "part_off"
    )
    missing = [
        f"{o['key']}.{p['key']}"
        for o in plan["operations"]
        if o["needed"] and not (o["key"] == "part" and part_off == "no")
        for p in o["params"]
        if p["suggestion"] is None
    ]
    assert missing == []
    assert r["ok"], r["problems"]
    assert r["validation"]["errors"] == []


def test_cut_blank_od_stops_where_the_proven_program_stops(
    client: TestClient, settings: Settings, db: Session, make_user: UserFactory
) -> None:
    """3216C11701 is a 50 mm blank held in the chuck: O0009 turns 23 mm, then flips it."""
    from app.seed import run_seed

    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-smarturn-55-04927"))
    assert m is not None
    _, r = _plan_and_preview(client, db, headers_for(make_user(Role.PROGRAMMER)), "3216C11701", m)
    lines = r["text"].splitlines()
    assert "G1Z-23.0" in lines and "G1Z-50.0" not in lines
    assert any("second clamping" in n for n in r["notes"])


def test_cuts_to_the_middle_of_the_tolerance_like_the_proven_programs(
    client: TestClient, settings: Settings, db: Session, make_user: UserFactory
) -> None:
    from app.seed import run_seed

    run_seed(settings, db)
    m = db.scalar(select(Machine).where(Machine.key == "lmw-smarturn-55-04927"))
    assert m is not None
    _, r = _plan_and_preview(client, db, headers_for(make_user(Role.PROGRAMMER)), "1627C00501", m)
    text = r["text"]
    assert "N100G0X27.42" in text  # 27.46 0/-0.08 -> 27.42, as O0003 line 62
    assert "N300G0X25.59" in text  # 25.55 +0.08/0 -> 25.59 (O0003: X25.6)


def test_not_lathe_drawings_say_so(client: TestClient, make_user: UserFactory) -> None:
    eng = headers_for(make_user(Role.ENGINEER))
    found = list((REPO.parent / "drawings").rglob("832100171 - Plate - Dwrg.pdf"))
    if not found:
        pytest.skip("drawing file not on this PC")
    plate = found[0]
    r = client.post(
        "/api/drawings/identify",
        files={"file": ("x.pdf", plate.read_bytes(), "application/pdf")},
        headers=eng,
    )
    assert r.status_code == 200 and "not made on a lathe" in r.json()["not_lathe"]
