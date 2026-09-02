# Redis image for one suite's isolated compose network (see
# docker/suite-compose.yaml). Pinned to the same major version the
# non-containerized default already assumes (redis 7). Built via a
# Dockerfile rather than referenced directly in compose so the artifact
# stays a valid `docker build` target, per the cross-OS "Docker-standard
# artifacts" requirement — this repo executes it locally with rootless
# podman, but the file itself makes no podman-specific assumption.
FROM docker.io/library/redis:7-alpine
