# Deterministic editing-agent test image. It bundles no provider CLI, model, or credential. The
# session runs it as the controller's non-root UID/GID; the image default user is non-root too.
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

COPY agent.mjs /opt/flowproof-agent/agent.mjs

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/flowproof-agent/agent.mjs", "/run/flowproof/task.json"]
