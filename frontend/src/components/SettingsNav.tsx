import { Button } from "./ui/button.jsx";

export const SETTINGS_GROUPS = [
  {
    group: "인박스",
    items: [
      { id: "members", label: "인박스 멤버" },
      { id: "hmac", label: "HMAC 시크릿" },
    ],
  },
  {
    group: "콘텐츠",
    items: [
      { id: "catalog", label: "카탈로그" },
      { id: "articles", label: "도움말" },
    ],
  },
  {
    group: "연동",
    items: [
      { id: "webhooks", label: "웹훅" },
      { id: "mcp", label: "MCP" },
      { id: "skills", label: "Agent Skills" },
    ],
  },
  {
    group: "분석",
    items: [{ id: "reports", label: "리포트" }],
  },
];

type SettingsNavProps = {
  tab: string;
  onChange: (id: string) => void;
};

export function SettingsNav({ tab, onChange }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="설정 메뉴">
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.group} className="settings-nav-group">
          <h2>{g.group}</h2>
          {g.items.map((item) => (
            <Button
              key={item.id}
              size="sm"
              className="justify-start"
              variant={tab === item.id ? "secondary" : "ghost"}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => onChange(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ))}
    </nav>
  );
}
