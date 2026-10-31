import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type Report = {
  csat_percent?: number;
  sla_hit_rate?: number;
  conversations?: {
    total?: number;
    unassigned?: number;
    open?: number;
    pending?: number;
    snoozed?: number;
    resolved?: number;
  };
  agents?: { name?: string; open_count?: number; resolved_count?: number }[];
  inboxes?: { name?: string; conversation_count?: number }[];
};

type ReportSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

const STATUS_COLORS = ["#94a3b8", "#10b981", "#f59e0b", "#64748b", "#6366f1"];

export function ReportSettings({ session, client }: ReportSettingsProps) {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    if (!client.getReport) {
      return undefined;
    }
    let cancelled = false;
    client
      .getReport({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setReport(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  const csat = report?.csat_percent ?? 0;
  const sla = report?.sla_hit_rate ?? 0;
  const conv = report?.conversations || {};
  const statusData = [
    { name: "미배정", value: conv.unassigned ?? 0 },
    { name: "진행", value: conv.open ?? 0 },
    { name: "대기", value: conv.pending ?? 0 },
    { name: "스누즈", value: conv.snoozed ?? 0 },
    { name: "해결", value: conv.resolved ?? 0 },
  ].filter((row) => row.value > 0);
  const agents = (report?.agents || []).map((a) => ({
    name: a.name || "상담원",
    open: a.open_count ?? 0,
    resolved: a.resolved_count ?? 0,
  }));
  const inboxes = (report?.inboxes || []).map((box) => ({
    name: box.name || "인박스",
    count: box.conversation_count ?? 0,
  }));

  return (
    <section className="settings-resource" aria-label="리포트">
      <h2>운영 리포트</h2>
      {report?.conversations ? (
        <p>
          대화 {report.conversations.total ?? 0} · 해결 {report.conversations.resolved ?? 0}
        </p>
      ) : null}
      <section className="settings-chart" aria-label="CSAT · SLA">
        <h3>CSAT · SLA</h3>
        <BarChart width={360} height={180} data={[{ name: "CSAT", value: csat }, { name: "SLA", value: sla }]}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis domain={[0, 100]} />
          <Tooltip cursor={false} />
          <Bar dataKey="value" fill="#0f766e" />
        </BarChart>
      </section>
      <section className="settings-chart" aria-label="대화 상태">
        <h3>대화 상태</h3>
        {statusData.length ? (
          <PieChart width={280} height={220}>
            <Pie data={statusData} dataKey="value" nameKey="name" cx={140} cy={100} innerRadius={45} outerRadius={80}>
              {statusData.map((row, i) => (
                <Cell key={row.name} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />
              ))}
            </Pie>
            <Legend />
            <Tooltip cursor={false} />
          </PieChart>
        ) : (
          <p>없음</p>
        )}
      </section>
      <section className="settings-chart" aria-label="상담원">
        <h3>상담원</h3>
        {agents.length ? (
          <BarChart layout="vertical" width={360} height={Math.max(140, agents.length * 44)} data={agents}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" />
            <YAxis type="category" dataKey="name" width={72} />
            <Tooltip cursor={false} />
            <Legend />
            <Bar dataKey="open" name="진행" fill="#10b981" />
            <Bar dataKey="resolved" name="해결" fill="#6366f1" />
          </BarChart>
        ) : (
          <p>없음</p>
        )}
      </section>
      <section className="settings-chart" aria-label="인박스">
        <h3>인박스</h3>
        {inboxes.length ? (
          <BarChart layout="vertical" width={360} height={Math.max(140, inboxes.length * 44)} data={inboxes}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" />
            <YAxis type="category" dataKey="name" width={72} />
            <Tooltip cursor={false} />
            <Bar dataKey="count" name="대화" fill="#0f766e" />
          </BarChart>
        ) : (
          <p>없음</p>
        )}
      </section>
    </section>
  );
}
