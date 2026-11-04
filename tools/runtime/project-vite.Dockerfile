# syntax=docker/dockerfile:1
#
# Operator-only offline toolchain for the Spec 006 `vite-static-v1` project profile.
#
# Build it only through `node tools/runtime/prepare-project-vite.mjs prepare`, which supplies a
# minimal build context holding exactly the locked `package.json` and `package-lock.json` of the
# permitted sample (T001) and nothing else. The dependency install happens here, at operator
# preparation time; the selected-project flow never pulls this image, installs packages, or
# reaches a network. The image bundles no provider CLI, model client, credential or `.npmrc`, and
# no build argument or secret is accepted. The runtime selects it only by its immutable image ID.

# Base image pinned by digest; a tag alone is never trusted.
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS dependencies

WORKDIR /opt/flowproof/toolchain
COPY package.json package-lock.json ./
# `npm ci` installs exactly the lock (integrity-checked tarballs) and fails on any mismatch.
# Lifecycle scripts never run; the npm cache stays outside the copied toolchain.
RUN npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
 && rm -rf /tmp/npm-cache

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# No package manager is available to a project at run time: the profile builds with the prepared
# dependency set only.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=dependencies --chown=0:0 /opt/flowproof/toolchain /opt/flowproof/toolchain
RUN chmod -R a-w,a+rX /opt/flowproof/toolchain

LABEL dev.flowproof.profile="vite-static-v1" \
      dev.flowproof.toolchain-root="/opt/flowproof/toolchain"

USER 65532:65532
WORKDIR /workspace
# Direct argv only: no shell entrypoint wraps the confirmed command.
ENTRYPOINT []
CMD ["node", "--version"]
