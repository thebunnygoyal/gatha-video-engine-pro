FROM gcr.io/windy-lyceum-460319-c7/gatha-video-engine-pro@sha256:e8cc2dcfa45ae2a37ffb04563fe080af9a9a5b86c91305173ef07803e3d7bc89 AS runtime
ARG SOURCE_REVISION
RUN test "${#SOURCE_REVISION}" = 40 && case "$SOURCE_REVISION" in *[!0-9a-f]*) exit 1 ;; esac
LABEL org.opencontainers.image.source="https://github.com/thebunnygoyal/gatha-video-engine-pro" \
      org.opencontainers.image.revision="$SOURCE_REVISION"
WORKDIR /app
COPY server.js ./server.js
COPY lib/ ./lib/
COPY src/ ./src/
CMD ["node", "server.js"]

FROM runtime AS verification
COPY tests/ ./tests/
COPY verify/ ./verify/
CMD ["node", "verify/run.js"]

FROM runtime AS production
