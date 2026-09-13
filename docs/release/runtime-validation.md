# Hosted runtime candidate validation

The owner confirmed on 2026-09-13 that no staging deployment or Daytona consumer is configured.
Local runtime validation is the available acceptance boundary.
It does not promote a hosted deployment or establish a prior-runtime rollback baseline.
The release remains npm-only; this image is not an interactive CLI installation channel.

## Build and inspect locally

Run from the private source checkout with Docker running:

```sh
DIFFEX_RUNTIME_COMMIT="$(git rev-parse HEAD)"
docker build --platform linux/amd64 \
  --build-arg "SOURCE_COMMIT=$DIFFEX_RUNTIME_COMMIT" \
  --file Dockerfile.runtime --tag diffex-runtime:candidate .
docker run --rm --platform linux/amd64 --network none \
  --mount "type=bind,src=$PWD/scripts/fixtures,dst=/acceptance,readonly" \
  --entrypoint node diffex-runtime:candidate /acceptance/runtime-smoke.mjs
docker save --output /tmp/diffex-runtime-candidate.tar diffex-runtime:candidate
python3 scripts/check-runtime-image.py /tmp/diffex-runtime-candidate.tar
docker inspect diffex-runtime:candidate
shasum -a 256 /tmp/diffex-runtime-candidate.tar
```

Use a clean committed source for retained acceptance and record its full commit.
Dirty-checkout results must also identify the uncommitted diff and cannot be attributed solely to the base commit label.
The Dockerfile pins the Node 24.16.0 base manifest digest and uses Linux amd64.
It hydrates validated model data, compiles workspace outputs, prunes development dependencies, and stages the required hosted runtime dependency closure.
The image carries compiled files, native runtime assets, the explicit user-documentation allowlist, and legal notices.
Project build inputs and private development documentation stay in the build stage.
Third-party redistribution materials remain with dependencies.

The fixture is mounted read-only for testing and never copied into a distribution layer.
It launches the actual server executable, uses a mock model provider and usage endpoint, verifies anonymous and incorrect-credential denial, rejects another session ID, exchanges a prompt and reply, and restarts using persisted session data.
External networking is disabled by Docker.
The test removes its directories and the container exits cleanly.
The layer checker examines every saved image layer so deleting an internal document in a later layer cannot hide its inclusion.

The manually dispatched Runtime Image workflow runs the same build, smoke, and layer checks on Linux amd64.
It retains the tested Docker archive, local image ID, archive checksum, and evidence in private Actions storage for 14 days.
It has read-only repository permissions and no registry publishing job.
There is no automatic main-branch image publication.

## Local evidence

On 2026-09-13, the development candidate passed the Linux amd64 build and smoke on Docker running on Darwin arm64.
The initial local image ID was `sha256:cfd4495ec712460a1400a1f6dda7f4352b7e48a659bed79505cf0c2f3714aad9`.
Its source label identifies base commit `06830a99220c3dad14292830171c433c916d49b1`; the branch's uncommitted runtime and packaging changes were also build inputs.
Layer inspection accepted 1,426 project files across 12 runtime workspaces and all 30 approved documentation assets.
This development image is not a registry release digest or a promoted artifact.
Final committed-candidate workflow evidence belongs in the implementation PR.

The npm lifecycle harness also passed on Darwin arm64 with Node 22.19.0, npm 10.9.3, and Bun 1.3.11.
It used the local candidate tarball, real npm installation processes, controlled release discovery, and a loopback registry for the canonical package.
Malformed release inputs and checksum mismatch preserved the installed prefix.
An interrupted download changed npm's prefix and required moving the exact stale backup before a pinned repair succeeded.
Bun global installation, PATH, real self-update, installed-byte verification, foreign-identity rejection, and removal also passed.
Removal retained user and project data, and all test-owned directories were removed.
Its version-metadata predecessor is a simulation; public-to-public upgrade acceptance remains separate.

## Registry and deployment prerequisites

Keep the future image private at `ghcr.io/diffexai/diffex-runtime` and configure scoped publisher and pull identities before publication.
Review the base-image and dependency license inventory, generate OCI SBOM and provenance attestations, and retain the image's registry manifest digest with its exact source and model-data inputs.
Docker's local exporter does not retain attestations, so the local archive does not claim SBOM/provenance acceptance.
Use a registry or OCI exporter for attested artifacts as described in [Docker's attestation documentation](https://docs.docker.com/build/metadata/attestations/).

The first hosted acceptance must pull the exact candidate from the intended staging environment, create a Daytona snapshot from its digest, and configure the cloud consumer explicitly.
Record the cloud commit, runtime commit, registry digest, snapshot, deployment owner, architecture, pull identity, and approved credential source without credential values.
Exercise real cloud allocation, attachment, streaming, reconnect, stop, cross-actor denial, and cleanup.
Only then retain the tested digest and snapshot as the first recovery baseline.
Every replacement must keep its previous tested configuration available, demonstrate restoration, and verify cleanup before retirement.
Registry publication, attestations, real provider inference, deployment promotion, and prior-runtime rollback are not completed by local testing.
