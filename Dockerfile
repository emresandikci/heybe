FROM node:24.16.0-bookworm-slim AS build
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable
WORKDIR /src
COPY . .
RUN CI=true pnpm install --frozen-lockfile
RUN cd packages/core && bun scripts/build-binary.ts

FROM debian:bookworm-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Heybe" \
      org.opencontainers.image.source="https://github.com/emresandikci/heybe" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /heybe --shell /usr/sbin/nologin heybe
COPY --from=build /src/packages/core/dist/heybe /usr/local/bin/heybe
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/heybe/
USER heybe
WORKDIR /heybe
RUN mkdir hb_data hb_migrations hb_hooks
VOLUME /heybe/hb_data
EXPOSE 8090
ENTRYPOINT ["heybe"]
CMD ["serve", "--http", "0.0.0.0:8090", "--dir", "/heybe/hb_data"]
