FROM python:3.13-slim AS x-collector
ARG APP_VERSION=0.0.0
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown
ARG SOURCE_URL=https://github.com/AmazingZ-sys/financial-radar
LABEL org.opencontainers.image.title="Financial Radar X Collector" \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source=$SOURCE_URL
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TWS_TELEMETRY=0 DO_NOT_TRACK=1 \
    APP_VERSION=$APP_VERSION COMMIT_SHA=$COMMIT_SHA
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 radar \
    && useradd --uid 10001 --gid radar --no-create-home radar
COPY collector.py ./
USER radar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"
CMD ["python", "collector.py"]
