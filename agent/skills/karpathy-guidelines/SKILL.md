---
name: karpathy-guidelines
description: Decision rules for whether code should exist - guards, try/except, fallbacks, abstractions, and tests. Use when writing, editing, reviewing, or testing code, especially before adding validation, error handling, helpers, or new tests.
license: MIT
---

# Extended Karpathy Guidelines

**Guiding principle:** Every abstraction, validation, dependency, defensive branch, and test must justify itself
through a concrete requirement or a named risk. Among equally correct solutions, choose the simpler one.

## 1. Think Before Coding

- Read the relevant code first; reuse its helpers, patterns, and style.
- State your assumptions. When two readings of the request lead to materially different work, ask; otherwise pick
  one, say which, and proceed.
- If a simpler approach exists, say so.
- Fix the root cause, not the symptom: check every caller of what you change.

## 2. Simplicity First

- No features, options, or configurability beyond what was asked.
- Keep single-use logic inline. No pass-through wrappers or speculative layers.
- Duplication is cheaper than the wrong abstraction: extract when the copies must change together, or on the third use.
- No new dependency, config, or architectural pattern without a concrete reason.
- If 200 lines could be 50, rewrite it.

## 3. Readability

**Code should read correctly the first time.**

- Names say what a thing is or does; booleans read as questions (`is_active`, `has_slot`). Follow the codebase's naming.
- Comments explain why: a constraint, workaround, or non-obvious decision. No comments that restate the code, narrate
  the change ("added X", "now uses Y"), divide steps, or hold commented-out code.
- Use early returns when they flatten nesting; keep the happy path at the lowest indentation.
- Name a number only when its meaning isn't obvious from context.
- Plain over clever: no nested ternaries or one-liners that need a second read.
- Split a function by responsibility, not length: split when describing it needs an "and".

## 4. Guards and Error Handling

**Name the input and the harm, or don't write the guard.**

Before adding a check, fallback, retry, lock, or timeout, name (1) the concrete input or state that reaches this line
and (2) what goes wrong without it. If you cannot name both, leave it out.

- Validate once, at the trust boundary: user input, network and API responses, files, env and config, deserialized
  data, nullable database fields. Inside, rely on the types and invariants already established.
- Catch an exception only to recover, translate it, or add context. Catch the narrowest type, never swallow it, and
  remember that letting it propagate is a valid choice.
- No silent fallbacks: a default that hides a failure is worse than a crash.
- Layered checks are justified only for security and authorization, destructive or irreversible operations, money or
  data integrity, explicitly required reliability, or a named code path that bypasses the boundary.
- For unlikely edge cases, add no code. If the impact would be material, note it in one summary line with its
  likelihood.

```python
# Before: guards for states the signature already rules out
def apply_discount(order: Order, user: User) -> None:
    if order is None or user is None:
        return
    try:
        order.total -= user.discount
    except Exception:
        logger.error("discount failed")

# After: the signature is the contract
def apply_discount(order: Order, user: User) -> None:
    order.total -= user.discount

# Before: a required key silently falls back
timeout = config.get("timeout_s", 30)
# After: a missing required key fails loudly at the boundary
timeout = config["timeout_s"]
```

## 5. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting, and don't refactor what isn't broken.
- Match existing style, even if you'd do it differently.
- Remove imports, variables, and functions that your change made unused; mention pre-existing dead code instead of
  deleting it.

Every changed line should trace directly to the request.

## 6. Tests That Earn Their Place

**Every test names the bug it catches.**

- Before writing a test, complete: "This fails if ___." If the honest answer is "the implementation changes", don't
  write it.
- List the ways the code can fail before writing it, and derive tests from that list rather than from re-reading the
  code you just wrote.
- One test per distinct failure mode, not per function or branch. Coverage is not a goal.
- Prefer the highest-level test the repo already supports that observes the behavior; keep unit tests for logic with
  real edge cases.
- Don't write tests that assert a mock received the exact arguments you just coded; pin constants, config, or wording;
  exercise trivial getters, constructors, or framework behavior; repeat a path an existing test covers; or stop at
  `is not None`.
- Extend an existing test before adding a file, and size new tests like their neighbors.
- Add tests only where the repo keeps tests for that area; otherwise verify by running the real entry point and say so.
- For a bug fix, reproduce the bug first and confirm the new test fails without the fix.

## 7. Goal-Driven Execution

- Turn the task into a check: "refactor X" -> same results before and after; "add boundary validation" -> a
  malformed input is rejected.
- For multi-step tasks, state each step with its verification.
- Run the targeted tests; widen only for risky or cross-cutting changes.
- Report what changed, how it was verified, and any material remaining risk.

## 8. Before You Finish

- Every guard names its input and harm; every catch names its exception.
- Every test names the bug it catches.
- Every comment explains why.
- Every new function is reused or makes the code clearer.
- Every changed line traces to the request.