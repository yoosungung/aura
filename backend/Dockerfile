# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG CMD=svc-core
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o /out/app ./cmd/${CMD}

FROM gcr.io/distroless/static-debian12 AS gateway-web
COPY --from=build /out/app /app
COPY --from=widget widget.html widget.js widget.min.js sdk.js aura-loader.min.js /widget/
ENV AURA_WIDGET_DIR=/widget
USER nonroot
ENTRYPOINT ["/app"]

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/app /app
USER nonroot
ENTRYPOINT ["/app"]
