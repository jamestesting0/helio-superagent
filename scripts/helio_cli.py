"""Argument parsing shared by Helio command-line tools."""
from __future__ import annotations

import argparse
import sys
from typing import Any, NoReturn


def positive(value: str) -> int:
    """An issue or other GitHub number; the selected subcommand reports a bad one with its example."""
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid number: {value!r}") from None
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


class ExampleParser(argparse.ArgumentParser):
    """A subcommand whose argument errors show one valid call beside the usage line."""

    def __init__(self, *args: Any, example: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.example = example

    def error(self, message: str) -> NoReturn:
        if self.example is None:
            super().error(message)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\nexample: {self.example}\n")
