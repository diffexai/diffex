"""Explicit execution policy for the pinned Diffex release."""

from typing import Literal

from harbor.agents.options import InstalledAgentOptions
from pydantic import field_validator


PROVIDER_ENV = {
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"),
    "openai": ("OPENAI_API_KEY",),
    "google": ("GEMINI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
}
BUILTIN_TOOLS = ("read", "bash", "edit", "write", "update_plan", "grep", "find", "ls")
SUBAGENT_TOOLS = ("spawn_agent", "agent_action", "agent_status")
USER_MESSAGE_SUFFIX = "\nDo not cheat by using online solutions or hints specific to this task."


class ExecutionOptions(InstalledAgentOptions):
    thinking: Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"] = "high"
    tools: str = "read,bash,edit,write,update_plan"
    subagents: Literal["disabled", "enabled"] = "disabled"
    project_resources: Literal["context-only"] = "context-only"
    background_process_lifetime: Literal["environment"] = "environment"
    # Arbitrary native config and prompt templates could defeat trial isolation
    # or alter the benchmark instruction. Reject them in Harbor preflight too.
    config: None = None
    prompt_template_path: None = None

    @field_validator("tools")
    @classmethod
    def validate_tools(cls, value: str) -> str:
        names = value.split(",")
        if not names or len(set(names)) != len(names) or any(name not in BUILTIN_TOOLS for name in names):
            raise ValueError("tools must be unique comma-separated built-in tool names")
        return value
