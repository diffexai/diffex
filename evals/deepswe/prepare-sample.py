"""Prepare a reproducible five-task sample without starting paid execution."""

import argparse
import asyncio
from importlib.metadata import version
import json
from pathlib import Path
import random
import secrets

import yaml
from harbor.models.job.config import JobConfig
from harbor.models.task.config import TaskConfig
from harbor.models.task.verifier_mode import resolve_effective_verifier_env_config
from harbor.registry.client.package import PackageDatasetClient
from harbor.tasks.client import TaskClient
from harbor.trial.network_policy import resolve_trial_network_plan

from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.execution import ExecutionOptions
from deepswe_e2b import prepare_image_runtimes


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    seed_path = output / "seed.json"
    if seed_path.exists():
        seed = json.loads(seed_path.read_text())["seed"]
        if args.seed is not None and args.seed != seed:
            raise RuntimeError("Use a new output directory for a different seed.")
    else:
        seed = args.seed if args.seed is not None else secrets.randbits(64)
        with seed_path.open("x") as stream:
            json.dump({"seed": seed}, stream)
            stream.write("\n")
    config = JobConfig.model_validate(yaml.safe_load((source / "sample.yaml").read_text()))
    if (PINS["diffex_version"], version("harbor"), version("e2b")) != ("0.3.2", "0.24.0", "2.59.0"):
        raise RuntimeError("Expected Diffex 0.3.2, Harbor 0.24.0, E2B 2.59.0.")
    if (config.n_attempts, config.n_concurrent_trials, config.retry.max_retries) != (2, 5, 0):
        raise RuntimeError("Expected two attempts, five concurrent trials, and zero retries.")
    if len(config.agents) != 1 or len(config.datasets) != 1 or config.tasks:
        raise RuntimeError("Expected one agent and one dataset only.")
    agent = config.agents[0]
    policy = ExecutionOptions.model_validate(agent.kwargs)
    if policy.task_environment != "preserve":
        raise RuntimeError("DeepSWE requires the task image's runtime environment.")
    if (agent.model_name, policy.thinking, policy.subagents) != ("openai/gpt-6-luna", "max", "disabled"):
        raise RuntimeError("Unexpected model or execution policy.")
    if config.environment.import_path != "deepswe_e2b:ResourceCheckedE2B":
        raise RuntimeError("Expected the resource-checked E2B backend.")
    if agent.extra_allowed_hosts != ["api.openai.com"] or config.environment.extra_allowed_hosts:
        raise RuntimeError("Only the model endpoint may be allowlisted.")
    dataset = config.datasets[0]
    if dataset.task_names or dataset.exclude_task_names or dataset.n_tasks:
        raise RuntimeError("The template must sample the entire dataset.")
    metadata = await PackageDatasetClient().get_dataset_metadata(f"{dataset.name}@{dataset.ref}")
    if metadata.version != dataset.ref or len(metadata.task_ids) != 113:
        raise RuntimeError("Expected the pinned 113-task dataset.")
    selected = random.Random(seed).sample(sorted(metadata.task_ids, key=lambda task: task.get_name()), 5)
    dataset.task_names = [task.get_name() for task in selected]
    dataset.download_dir = output / "task-cache"
    downloads = await TaskClient().download_tasks(selected, output_dir=dataset.download_dir)
    records = []
    images = []
    for task_id, path in zip(selected, downloads.paths, strict=True):
        task = TaskConfig.model_validate_toml((path / "task.toml").read_text())
        if not task.environment.docker_image:
            raise RuntimeError("DeepSWE requires a published task image.")
        images.append(task.environment.docker_image)
        if task.verifier.environment_mode.value != "separate" or not task.verifier.collect:
            raise RuntimeError(f"{task_id.get_name()} requires separate commit-based verification.")
        verifier_env = resolve_effective_verifier_env_config(task, None)
        plan = resolve_trial_network_plan(
            task, agent, config.environment, None,
            verifier_mode=task.verifier.environment_mode, env_config=verifier_env,
        )
        if plan.agent_phase.network_mode.value != "allowlist" or plan.agent_phase.allowed_hosts != ["api.openai.com"]:
            raise RuntimeError("Unexpected agent network policy.")
        if plan.verifier_phase.network_mode.value != "no-network":
            raise RuntimeError("The verifier must remain offline.")
        records.append({
            "name": task_id.get_name(), "ref": task_id.ref,
            "agent_timeout_sec": task.agent.timeout_sec,
            "verifier_timeout_sec": task.verifier.timeout_sec,
            "cpus": task.environment.cpus, "memory_mb": task.environment.memory_mb,
            "minimum_storage_mb": task.environment.storage_mb,
            "agent_network": plan.agent_phase.model_dump(mode="json"),
            "verifier_network": plan.verifier_phase.model_dump(mode="json"),
        })
    resolved_tasks = await dataset.get_task_configs()
    if {task.name for task in resolved_tasks} != set(dataset.task_names) or len(resolved_tasks) != 5:
        raise RuntimeError("Harbor did not resolve exactly the selected five tasks.")
    catalog = output / "runtime-images.json"
    config.environment.kwargs.update(runtime_catalog=str(catalog),
                                     runtime_catalog_sha256=await prepare_image_runtimes(images, catalog))
    config_path = output / "job.yaml"
    # Keep preparation idempotent despite Harbor's timestamp-based job-name default.
    config.job_name = "sample-5x2"
    serialized = yaml.safe_dump(config.model_dump(mode="json", exclude_none=True), sort_keys=False)
    if config_path.exists():
        previous = JobConfig.model_validate(yaml.safe_load(config_path.read_text()))
        if previous != config:
            raise RuntimeError("Prepared configuration changed; use a fresh preparation directory.")
    else:
        config_path.write_text(serialized)
    manifest = {
        "seed": seed, "dataset": metadata.name, "dataset_ref": metadata.version,
        "dataset_task_count": 113, "tasks": records, "n_attempts": 2,
        "n_trials": 10, "n_concurrent_trials": 5, "diffex_version": PINS["diffex_version"],
        "model": agent.model_name, "thinking": policy.thinking,
        "subagents": policy.subagents, "evolution_enabled": False,
        "task_environment": policy.task_environment,
        "live_validation": "not_started",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared 5 tasks x 2 attempts = 10 trials; concurrency 5; seed {seed}.")
    for record in records:
        print(f"  {record['name']}: {record['cpus']} CPU, {record['memory_mb']} MiB RAM, {record['minimum_storage_mb']} MiB disk")
    print(f"Configuration: {config_path}\nNo sandboxes or model calls have started.")


if __name__ == "__main__":
    asyncio.run(main())
