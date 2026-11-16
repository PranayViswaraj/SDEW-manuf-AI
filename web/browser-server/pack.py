"""Pack the server code + sample data the browser server needs into web/public/pyserver.zip.

Run from the repository root:  python web/browser-server/pack.py
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "public" / "pyserver.zip"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "server" / "alembic.ini", "alembic.ini")
        z.write(Path(__file__).with_name("boot.py"), "browser_boot.py")
        for base, arc in ((ROOT / "server" / "app", "app"), (ROOT / "samples", "samples")):
            for f in sorted(base.rglob("*")):
                if f.is_file() and "__pycache__" not in f.parts and f.suffix != ".pyc":
                    z.write(f, f"{arc}/{f.relative_to(base).as_posix()}")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
