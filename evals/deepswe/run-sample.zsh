#!/bin/zsh
set -eu
umask 077
DS_SETUP=${0:A:h}
DS_REPO=${DS_SETUP:h:h}
DS_PREPARED=${DS_PREPARED:-$DS_REPO/.artifacts/deepswe/prepared-5x2-runtime-v3}
cd "$DS_REPO/evals/terminal-bench"
export PYTHONPATH="$DS_SETUP${PYTHONPATH:+:$PYTHONPATH}"
DS_UV=(uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked)
[[ $# -le 1 ]] || { print -u2 'Too many arguments.'; exit 1; }
case "${1:-}" in
  --prepare)
    "${DS_UV[@]}" python "$DS_SETUP/prepare-sample.py" --output "$DS_PREPARED"
    exit ;;
  --print-config)
    "${DS_UV[@]}" harbor run --config "$DS_PREPARED/job.yaml" --print-config
    exit ;;
  '') ;;
  *) print -u2 'Usage: run-sample.zsh [--prepare|--print-config]'; exit 1 ;;
esac
"${DS_UV[@]}" python "$DS_SETUP/prepare-sample.py" --output "$DS_PREPARED"
if [[ -z "${E2B_API_KEY:-}" ]]; then
  read -rs 'E2B_API_KEY?E2B API key: '
  printf '\n'
fi
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  read -rs 'OPENAI_API_KEY?OpenAI API key: '
  printf '\n'
fi
[[ -n "$E2B_API_KEY" && -n "$OPENAI_API_KEY" ]] || { print -u2 'Both API keys are required.'; exit 1; }
export E2B_API_KEY OPENAI_API_KEY
DS_OUTPUT="results/deepswe-1-1-luna-max-5x2-$(date +%Y%m%d-%H%M%S)-$(uuidgen)"
mkdir -p results
mkdir "$DS_OUTPUT"
cp "$DS_PREPARED"/{job.yaml,manifest.json,seed.json,runtime-images.json} "$DS_OUTPUT/"
cp "$DS_SETUP"/{sample.yaml,prepare-sample.py,run-sample.zsh,deepswe_e2b.py} "$DS_OUTPUT/"
cp -R src/diffex_terminal_bench "$DS_OUTPUT/adapter-source"
git rev-parse HEAD > "$DS_OUTPUT/adapter-commit.txt"
git -C "$DS_REPO" diff --binary -- evals/terminal-bench > "$DS_OUTPUT/adapter-working-tree.diff"
"${DS_UV[@]}" harbor run --config "$DS_OUTPUT/job.yaml" --jobs-dir "$DS_OUTPUT" --job-name sample-5x2 --print-config > "$DS_OUTPUT/planned-config.json"
print "Starting 10 DeepSWE trials, concurrency 5. Results: $PWD/$DS_OUTPUT/sample-5x2"
"${DS_UV[@]}" harbor run --config "$DS_OUTPUT/job.yaml" --jobs-dir "$DS_OUTPUT" --job-name sample-5x2
