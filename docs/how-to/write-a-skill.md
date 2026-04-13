# Write A Skill

Use this guide to add a discoverable, activatable skill to `mini-agent`.

## 1. Create the skill directory

For a workspace-local skill, create:

```text
.agents/skills/<skill-name>/SKILL.md
```

Example:

```text
.agents/skills/intel-bulletin/SKILL.md
```

The runtime also discovers skills from configured global and explicit skill directories, but the workspace path is the simplest place to start.

## 2. Write the required frontmatter

`SKILL.md` must start with YAML frontmatter. The current parser requires:

- `name`
- `description`

Optional fields currently recognized:

- `license`
- `compatibility`
- `allowed-tools`
- `metadata`

Example:

```md
---
name: intel-bulletin
description: Turn source notes into a short formal bulletin.
compatibility: mini-agent v1
allowed-tools:
  - read
  - write
license: MIT
---

# Intel Bulletin

Turn source notes into a short bulletin with a decision section and a risk section.
```

## 3. Write the activation body

The Markdown body after the frontmatter is what the runtime injects after `activate_skill` succeeds.

Good skill bodies are:

- specific about inputs and outputs
- explicit about when to read or write files
- scoped to one task
- short enough to fit comfortably in context

## 4. Add optional resources

The runtime recognizes these optional directories under the skill root:

- `scripts/`
- `references/`
- `assets/`

Example:

```text
.agents/skills/intel-bulletin/
├── SKILL.md
├── references/
│   └── tone-guide.md
└── scripts/
    └── render-template.ts
```

Discovery does not load these directories up front. They are inventoried only when the skill is activated.

## 5. Verify discovery

Run:

```bash
npm run dev -- skills list
```

You should see your skill name and description in the catalog output.

If you do not, check:

- the skill directory contains `SKILL.md`
- the frontmatter has both `name` and `description`
- the skill is under a discovered root

## 6. Verify activation

There is no standalone CLI command that force-activates a skill. Activation happens when the model calls `activate_skill`.

The two practical checks are:

1. run a prompt that should clearly need the skill
2. add a deterministic test around `SkillRegistry.activate()`

The existing unit tests in `tests/unit/skill-registry.test.ts` are the right pattern for activation checks.

## 7. Prepare fixtures for the skill

Before treating a skill as production-ready, add stable fixtures for it.

A minimal fixture set usually includes:

- one sample input
- one expected output or acceptance shape
- one test that proves discovery and activation still work

Suggested layout:

```text
fixtures/<skill-name>/
├── source-note.md
└── expected-report.md
```

Then add a test that checks at least:

- the skill is discoverable
- the skill can be activated
- activation records a `skill_activation` entry when used in a runtime flow

## 8. Keep progressive disclosure intact

When authoring a skill, assume the runtime behaves in two phases:

1. startup sees only metadata from frontmatter
2. activation loads the body and resource inventory

That means:

- put catalog-quality summary text in `description`
- keep large reference material in `references/`, not in the frontmatter
- keep task instructions in the body, not in the directory name
