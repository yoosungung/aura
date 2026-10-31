import { useEffect, useState } from "react";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type Report = {
  csat_percent?: number;
  sla_hit_rate?: number;
  conversations?: { total?: number; resolved?: number };
};

type ReportSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

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

  return (
    <section className="settings-resource" aria-label="리포트">
      <h2>운영 리포트</h2>
      <p>
        CSAT% <span data-testid="csat-percent">{csat}</span>
      </p>
      <p>
        SLA hit rate <span data-testid="sla-hit-rate">{sla}</span>
      </p>
      {report?.conversations ? (
        <p>
          대화 {report.conversations.total ?? 0} · 해결 {report.conversations.resolved ?? 0}
        </p>
      ) : null}
    </section>
  );
}
