---
name: karpathy-guidelines
description: Decision rules for whether code should exist - guards, try/except, fallbacks, abstractions, and tests. Use when writing, editing, reviewing, or testing code, especially before adding validation, error handling, helpers, or new tests.
license: MIT
---

# Small, correct changes

Use these engineering guidelines within the task's authorization policy. They do
not add approval steps or override a clear request.

## Understand the cause

Read the relevant code, callers and tests. Reuse existing helpers and conventions.
Trace a failure to its owner before fixing it; a retry or fallback is not a
diagnosis. Resolve uncertainty from context. State a reasonable assumption unless
different readings would materially change correctness, scope or authority.

## Keep the change necessary

Every changed line must serve the request. Preserve unrelated work and match the
codebase's style. Remove what your change makes unused; report unrelated problems
without expanding the task.

Prefer existing code, then the standard library, then the smallest new code.
No speculative features, options, dependencies or architecture. Keep single-use
logic inline; extract when callers must change together or repetition earns it.
Split responsibilities rather than adding pass-through layers.

Use names that express intent, simple control flow and early returns. Comments
explain reasons or non-obvious constraints, not the code or edit history.

## Validate at boundaries

Before adding a guard, retry, fallback, lock or timeout, name the concrete input
and harm it prevents. Validate external data once at its trust boundary; rely on
internal contracts. Additional checks need a security, authorization, data
integrity or demonstrated reliability reason.

Catch only errors you can recover from, translate or explain. Catch narrowly;
never swallow failure or silently substitute a value that hides it.

## Verify the outcome

Define what proves the requested behavior, including relevant failure paths.
For a bug, reproduce it before fixing it. Extend existing coverage at the strongest
practical boundary; each new test must fail on a credible regression not already
covered. Avoid prose pins, source greps, mock echoes and tests that mirror code.
If no behavioral seam exists, exercise the real entry point and report the limit.

Run checks proportional to the change and complete repository-required gates.
Reuse passing evidence until code, relevant inputs or a failure invalidate it.
Do not weaken a failing check. Report the observed result and remaining risk;
stop when the requested outcome is verified.
