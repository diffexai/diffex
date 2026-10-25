"""Resolve pinned inputs and validate the smoke configuration without running it."""

import argparse
import asyncio
from importlib.metadata import version
import json
from pathlib import Path

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
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    config = JobConfig.model_validate(yaml.safe_load((source / "smoke.yaml").read_text()))
    if (PINS["diffex_version"], version("harbor"), version("e2b")) != ("0.3.2", "0.24.0", "2.59.0"):
        raise RuntimeError("Expected Diffex 0.3.2, Harbor 0.24.0, and E2B 2.59.0.")
    if (config.n_attempts, config.n_concurrent_trials, config.retry.max_retries) != (1, 1, 0):
        raise RuntimeError("The smoke trial requires one attempt, concurrency one, and zero retries.")
    agent = config.agents[0]
    policy = ExecutionOptions.model_validate(agent.kwargs)
    if policy.task_environment != "preserve":
        raise RuntimeError("DeepSWE requires the task image's runtime environment.")
    if (agent.model_name, policy.thinking, policy.subagents) != ("openai/gpt-6-luna", "max", "disabled"):
        raise RuntimeError("Unexpected model or execution policy.")
    if agent.extra_allowed_hosts != ["api.openai.com"] or config.environment.extra_allowed_hosts:
        raise RuntimeError("Only the model endpoint may be allowlisted during agent execution.")
    if any(value is not None for value in (
        config.environment.override_cpus, config.environment.override_memory_mb,
        config.environment.override_storage_mb, agent.override_timeout_sec,
        config.verifier.override_timeout_sec,
    )):
        raise RuntimeError("Do not override task resources or execution deadlines.")
    dataset = config.datasets[0]
    metadata = await PackageDatasetClient().get_dataset_metadata(f"{dataset.name}@{dataset.ref}")
    if metadata.version != dataset.ref or len(metadata.task_ids) != 113:
        raise RuntimeError("The dataset must resolve to the pinned 113-task release.")
    tasks = await dataset.get_task_configs()
    if len(tasks) != 1 or tasks[0].name != "datacurve/abs-stepped-slices":
        raise RuntimeError("The smoke selection must contain only abs-stepped-slices.")
    selected = [task for task in metadata.task_ids if task.name == "abs-stepped-slices"]
    downloads = await TaskClient().download_tasks(selected, output_dir=args.output / "task-cache")
    task = TaskConfig.model_validate_toml((downloads.paths[0] / "task.toml").read_text())
    if (task.environment.cpus, task.environment.memory_mb, task.environment.storage_mb) != (2, 8192, 20480):
        raise RuntimeError("Unexpected smoke task resource limits.")
    if str(task.verifier.environment_mode.value) != "separate" or not task.verifier.collect:
        raise RuntimeError("DeepSWE requires separate verification and commit collection.")
    verifier_env = resolve_effective_verifier_env_config(task, None)
    plan = resolve_trial_network_plan(
        task, agent, config.environment, None,
        verifier_mode=task.verifier.environment_mode, env_config=verifier_env,
    )
    if plan.agent_phase.network_mode.value != "allowlist" or plan.agent_phase.allowed_hosts != ["api.openai.com"]:
        raise RuntimeError("Agent execution network isolation was not resolved correctly.")
    if plan.verifier_phase.network_mode.value != "no-network":
        raise RuntimeError("The verifier must remain offline.")
    args.output.mkdir(parents=True, exist_ok=True)
    if not task.environment.docker_image:
        raise RuntimeError("DeepSWE requires a published task image.")
    catalog = args.output.resolve() / "runtime-images.json"
    config.environment.kwargs.update(runtime_catalog=str(catalog), runtime_catalog_sha256=
                                     await prepare_image_runtimes([task.environment.docker_image], catalog))
    config.job_name = "smoke"
    (args.output / "job.yaml").write_text(yaml.safe_dump(config.model_dump(mode="json", exclude_none=True), sort_keys=False))
    manifest = {
        "dataset": metadata.name, "dataset_ref": metadata.version, "dataset_task_count": 113,
        "selected_task": tasks[0].model_dump(mode="json", exclude_none=True),
        "diffex_version": PINS["diffex_version"], "model": agent.model_name, "thinking": policy.thinking,
        "subagents": policy.subagents, "evolution_enabled": False,
        "task_environment": policy.task_environment,
        "agent_network": plan.agent_phase.model_dump(mode="json"),
        "verifier_network": plan.verifier_phase.model_dump(mode="json"),
        "agent_timeout_sec": task.agent.timeout_sec, "verifier_timeout_sec": task.verifier.timeout_sec,
        "resource_requirements": {"cpus": 2, "memory_mb": 8192, "minimum_storage_mb": 20480},
        "live_validation": "not_started",
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Prepared abs-stepped-slices: Luna max, no evolution/subagents, separate offline verifier.")
    print("Required per sandbox: 2 vCPU, 8 GiB RAM, at least 20 GiB disk; no trial has started.")


if __name__ == "__main__":
    asyncio.run(main())
