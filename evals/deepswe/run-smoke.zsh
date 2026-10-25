#!/bin/zsh
set -eu
umask 077
DS_SETUP=${0:A:h}
DS_REPO=${DS_SETUP:h:h}
cd "$DS_REPO/evals/terminal-bench"
export PYTHONPATH="$DS_SETUP${PYTHONPATH:+:$PYTHONPATH}"
DS_UV=(uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked)
[[ $# -le 1 ]] || { print -u2 'Too many arguments.'; exit 1; }
case "${1:-}" in
  --print-config)
    "${DS_UV[@]}" harbor run --config "$DS_REPO/.artifacts/deepswe/prepared-runtime-v3/job.yaml" --print-config
    exit ;;
  --prepare)
    "${DS_UV[@]}" python "$DS_SETUP/prepare.py" --output "$DS_REPO/.artifacts/deepswe/prepared-runtime-v3"
    exit ;;
  '') ;;
  *) print -u2 'Usage: run-smoke.zsh [--prepare|--print-config]'; exit 1 ;;
esac
[[ -n "${E2B_API_KEY:-}" ]] || { print -u2 'Export E2B_API_KEY in this terminal first.'; exit 1; }
[[ -n "${OPENAI_API_KEY:-}" ]] || { print -u2 'Export OPENAI_API_KEY in this terminal first.'; exit 1; }
DS_OUTPUT="results/deepswe-1-1-luna-max-smoke-$(date +%Y%m%d-%H%M%S)-$(uuidgen)"
mkdir -p results
mkdir "$DS_OUTPUT"
"${DS_UV[@]}" python "$DS_SETUP/prepare.py" --output "$DS_OUTPUT/inputs"
cp "$DS_OUTPUT/inputs/job.yaml" "$DS_OUTPUT/job.yaml"
cp "$DS_SETUP"/{deepswe_e2b.py,prepare.py,verify-smoke.py,run-smoke.zsh} "$DS_OUTPUT/"
cp src/diffex_terminal_bench/{pins.toml,run.cjs} "$DS_OUTPUT/"
cp -R src/diffex_terminal_bench "$DS_OUTPUT/adapter-source"
git rev-parse HEAD > "$DS_OUTPUT/adapter-commit.txt"
git -C "$DS_REPO" diff --binary -- evals/terminal-bench > "$DS_OUTPUT/adapter-working-tree.diff"
"${DS_UV[@]}" harbor run --config "$DS_OUTPUT/job.yaml" --jobs-dir "$DS_OUTPUT" --job-name smoke --print-config > "$DS_OUTPUT/planned-config.json"
print "Starting one DeepSWE smoke trial. Results: $PWD/$DS_OUTPUT/smoke"
print 'Task correctness may fail; smoke qualification checks execution, isolation, and retained evidence.'
"${DS_UV[@]}" harbor run --config "$DS_OUTPUT/job.yaml" --jobs-dir "$DS_OUTPUT" --job-name smoke
"${DS_UV[@]}" python "$DS_SETUP/verify-smoke.py" "$DS_OUTPUT/smoke"
