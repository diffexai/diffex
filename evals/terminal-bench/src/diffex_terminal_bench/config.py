"""Checked-in installation pins shared by the adapter and smoke runner."""

from importlib.resources import files
import tomllib


PINS = tomllib.loads(files(__package__).joinpath("pins.toml").read_text())
