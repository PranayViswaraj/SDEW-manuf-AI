# DEV image: runs the bridge with SIMULATED machines (config.dev.yaml).
# On the factory PC the bridge runs as a Windows service / systemd unit instead (see README).
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /bridge
COPY pyproject.toml ./
COPY bridge ./bridge
COPY tools ./tools
COPY config.dev.yaml ./
RUN pip install --no-cache-dir .
CMD ["manufai-bridge", "--config", "config.dev.yaml"]
