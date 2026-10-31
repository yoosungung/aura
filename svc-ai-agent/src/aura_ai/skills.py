from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml
from langchain.agents.middleware import AgentMiddleware
from langchain.tools import tool

def _skills_dir() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here.parents[2] / "skills", Path("/app/skills"), here.parent / "skills"):
        if candidate.exists():
            return candidate
    return here.parents[2] / "skills"


SKILLS_DIR = _skills_dir()


@dataclass
class Skill:
    name: str
    description: str
    body: str
    enabled: bool = True


def parse_skill_md(text: str) -> Skill:
    raw = text.lstrip("\ufeff")
    if not raw.startswith("---"):
        return Skill(name="unnamed", description="", body=raw)
    rest = raw[3:]
    end = rest.find("\n---")
    if end < 0:
        return Skill(name="unnamed", description="", body=raw)
    meta = yaml.safe_load(rest[:end]) or {}
    body = rest[end + 4 :].strip()
    return Skill(
        name=str(meta.get("name") or "unnamed"),
        description=str(meta.get("description") or ""),
        body=body,
    )


def load_builtin_skills(root: Path | None = None) -> dict[str, Skill]:
    base = root or SKILLS_DIR
    out: dict[str, Skill] = {}
    if not base.exists():
        return out
    for path in sorted(base.glob("*/SKILL.md")):
        skill = parse_skill_md(path.read_text(encoding="utf-8"))
        out[skill.name] = skill
    return out


def merge_skills(builtin: dict[str, Skill], tenant: list[dict] | None = None) -> dict[str, Skill]:
    out = dict(builtin)
    for row in tenant or []:
        if row.get("enabled") is False:
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        out[name] = Skill(
            name=name,
            description=str(row.get("description") or ""),
            body=str(row.get("body") or ""),
            enabled=True,
        )
    return out


def catalog_prompt(skills: dict[str, Skill]) -> str:
    if not skills:
        return ""
    lines = ["Available skills (call load_skill to read full instructions):"]
    for skill in skills.values():
        lines.append(f"- {skill.name}: {skill.description}")
    return "\n".join(lines)


class SkillsMiddleware(AgentMiddleware):
    def __init__(self, skills: dict[str, Skill] | None = None) -> None:
        super().__init__()
        self.skills = skills or {}

    def load(self, name: str) -> str:
        skill = self.skills.get(name)
        if skill is None:
            return f"unknown skill: {name}"
        return skill.body

    def tool(self):
        skills = self.skills

        @tool
        def load_skill(name: str) -> str:
            """Load full Agent Skill instructions by name."""
            skill = skills.get(name)
            if skill is None:
                return f"unknown skill: {name}"
            return skill.body

        return load_skill
