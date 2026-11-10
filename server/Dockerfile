FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Latest Debian security fixes on top of the base image.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
COPY alembic.ini ./
RUN pip install . \
    && useradd --system --uid 10001 --home /srv manufai \
    && chown -R manufai /srv

# Never run the server as root.
USER manufai
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

# One worker on purpose: live machine status and bridge connections are held in memory
# (see docs/architecture.md). Migrations run before the server starts; the seed only creates
# the LMW machine and imports trusted programs unless MANUFAI_SEED_DEV_DATA=true.
CMD ["sh", "-c", "alembic upgrade head && python -m app.seed && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips='*' --no-server-header"]
