"""Users, roles and append-only audit log (Milestone 2).

Revision ID: 0002_users_audit
Revises: 0001_baseline
Create Date: 2026-11-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.db.types import UTCDateTime

revision: str = "0002_users_audit"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

APPEND_ONLY_MSG = "audit_log is append-only: entries cannot be changed or deleted"


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("full_name", sa.String(128), nullable=False, server_default=""),
        sa.Column("password_hash", sa.String(256), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("can_start_machine", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    op.create_table(
        "user_roles",
        sa.Column(
            "user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("role", sa.String(32), primary_key=True),
    )

    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("timestamp", UTCDateTime(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("username", sa.String(64), nullable=True),
        sa.Column("machine_id", sa.Integer(), nullable=True),
        sa.Column("program_id", sa.Integer(), nullable=True),
        sa.Column("program_hash", sa.String(64), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("result", sa.String(32), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
    )
    op.create_index("ix_audit_log_timestamp", "audit_log", ["timestamp"])
    op.create_index("ix_audit_log_user_id", "audit_log", ["user_id"])
    op.create_index("ix_audit_log_machine_id", "audit_log", ["machine_id"])
    op.create_index("ix_audit_log_action", "audit_log", ["action"])

    # Database-level append-only guard (safety rule 7).
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        for event in ("UPDATE", "DELETE"):
            op.execute(
                f"CREATE TRIGGER audit_log_no_{event.lower()} BEFORE {event} ON audit_log "
                f"BEGIN SELECT RAISE(ABORT, '{APPEND_ONLY_MSG}'); END;"
            )
    elif dialect == "postgresql":
        op.execute(
            "CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$ "
            f"BEGIN RAISE EXCEPTION '{APPEND_ONLY_MSG}'; END; $$ LANGUAGE plpgsql;"
        )
        op.execute(
            "CREATE TRIGGER audit_log_no_modify BEFORE UPDATE OR DELETE ON audit_log "
            "FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();"
        )
        op.execute(
            "CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log "
            "FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();"
        )


def downgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "postgresql":
        op.execute("DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log")
        op.execute("DROP TRIGGER IF EXISTS audit_log_no_modify ON audit_log")
        op.execute("DROP FUNCTION IF EXISTS audit_log_append_only()")
    op.drop_table("audit_log")
    op.drop_table("user_roles")
    op.drop_index("ix_users_username", table_name="users")
    op.drop_table("users")
