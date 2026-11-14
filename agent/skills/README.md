# Skills shipped with Helio

Installed under `~/.dori/elobot/skills/` and passed to the lead (`agent/bin/start`) and to
every lane (`agent/config.template.json`) with `omo --skill`. Only each skill's name and
description stay in context; the body loads when a task matches.

| Skill | Source | Copied |
|-------|--------|--------|
| `karpathy-guidelines` (MIT) | the owner's `~/.agents/skills/karpathy-guidelines/SKILL.md` | 2026-11-14 |

The isolated runtime cannot read the owner's home, so these are copies. To ship an edited
skill, copy it over the file here and run `helio update`; `helio update` prints a note when
the owner's copy differs from this one.
