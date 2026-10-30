import { Badge } from "./ui/badge.jsx";

const TONE = {
  PainPoint: "destructive",
  Product: "default",
  Preference: "secondary",
  Feature: "outline",
};

export function LivingProfile({ nodes = [] }) {
  return (
    <section className="context-card" aria-label="Living Profile">
      <p>Living Profile</p>
      {nodes.length === 0 ? <p>그래프 없음</p> : null}
      <div className="profile-chips">
        {nodes.map((n) => (
          <Badge key={n.id || n.name} variant={TONE[n.entity_type] || "secondary"} data-entity={n.entity_type}>
            {n.entity_type} {n.name}
          </Badge>
        ))}
      </div>
    </section>
  );
}
