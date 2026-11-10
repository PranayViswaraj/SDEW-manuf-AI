"""Which machines can make a confirmed part, and are online and idle right now (Milestone 13)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import any_user
from app.db.models import FeatureTable, Machine, User
from app.db.session import get_db
from app.services.bridge_hub import BridgeHub
from app.services.capability_check import availability, check_capability
from app.services.feature_tables import feature_table_problem

router = APIRouter(prefix="/capability", tags=["capability"])


@router.get("")
def machines_for_part(
    feature_table_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(any_user),
) -> dict[str, Any]:
    ft = db.get(FeatureTable, feature_table_id)
    if ft is None:
        raise HTTPException(404, "Feature table not found.")
    if problem := feature_table_problem(db, ft.part_number):
        raise HTTPException(409, f"Confirm the feature table first. {problem}")
    hub: BridgeHub = request.app.state.hub
    available, excluded = [], []
    for m in db.scalars(select(Machine).order_by(Machine.name)):
        result = check_capability(ft.data, m)
        live = hub.live_view(m.key, m.bridge_id)
        ready, not_ready = availability(live)
        row = {
            "machine_id": m.id,
            "machine_name": m.name,
            "live_state": live["state"],
            **result.to_dict(),
            "availability": not_ready,
        }
        if result.capable and ready:
            available.append(row)
        else:
            row["excluded_because"] = (
                [r["message"] for r in row["reasons"] if r["status"] != "pass"]
                if not result.capable
                else not_ready
            )
            excluded.append(row)
    return {"part_number": ft.part_number, "available": available, "excluded": excluded}
