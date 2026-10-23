import type { Report } from "../../src/report";
import { Collapsed, Row } from "@/components/list";
import { Button } from "@/components/ui/button";

/** Ignored versions (with un-ignore) and plugins with nothing to do. */
export function CollapsedLists({
  report,
  onUnignore,
}: {
  report: Report;
  onUnignore: (id: string, version: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Collapsed title="Ignored" count={report.ignored.length}>
        {report.ignored.map((item) => (
          <Row
            key={`${item.id}@${item.version}`}
            id={item.id}
            actions={
              <Button variant="ghost" size="sm" onClick={() => onUnignore(item.id, item.version)}>
                Un-ignore
              </Button>
            }
          >
            {item.kind === "out-of-range" ? `${item.from} → ${item.to}` : item.to}
          </Row>
        ))}
      </Collapsed>
      <Collapsed title="Up to date" count={report.upToDate.length}>
        {report.upToDate.map((item) => (
          <Row key={item.id} id={item.id}>
            {item.installed}
          </Row>
        ))}
      </Collapsed>
      <Collapsed title="Pinned, built in, or unavailable" count={report.other.length}>
        {report.other.map((item) => (
          <Row key={item.id} id={item.id}>
            {item.outcome} · {item.installed}
            {item.detail === undefined ? "" : ` · ${item.detail}`}
          </Row>
        ))}
      </Collapsed>
    </div>
  );
}
