"""drawings and generator defaults

Revision ID: 0008_drawings_generator
Revises: 0007_runs_feature_tables
Create Date: 2026-11-13 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.db.types

revision: str = "0008_drawings_generator"
down_revision: str | None = "0007_runs_feature_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "drawings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("part_number", sa.String(length=64), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("uploaded_by", sa.Integer(), nullable=True),
        sa.Column("uploaded_by_name", sa.String(length=128), nullable=False),
        sa.Column("uploaded_at", app.db.types.UTCDateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("drawings", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_drawings_part_number"), ["part_number"])
    with op.batch_alter_table("machines", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("generator_defaults", sa.JSON(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    with op.batch_alter_table("machines", schema=None) as batch_op:
        batch_op.drop_column("generator_defaults")
    with op.batch_alter_table("drawings", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_drawings_part_number"))
    op.drop_table("drawings")
