# syntax=docker/dockerfile:1

# The build stages run on the build machine's own platform and cross-compile,
# which is much faster than emulating other architectures.

# 1. Minify the web files that get embedded into the binary.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS web
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install github.com/tdewolff/minify/v2/cmd/minify@v2.24.20
WORKDIR /src
COPY web/ web/
RUN minify --recursive --output dist/ web/

# 2. Build a static binary with the minified files embedded.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
COPY --from=web /src/dist/ web/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/qrcpy .

# 3. Just the binary.
FROM scratch
COPY --from=build /out/qrcpy /qrcpy
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/qrcpy", "-healthcheck"]
ENTRYPOINT ["/qrcpy"]
