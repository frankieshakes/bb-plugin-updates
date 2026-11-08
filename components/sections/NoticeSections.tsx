import type { Report } from "../../src/report";
import type { PluginCheckFailure } from "../../src/store";
import { Row, Section } from "@/components/list";

/** Things the user can't act on here: blocked releases and failed update or release checks. */
export function NoticeSections({
  report,
  updateCheckFailures = [],
}: {
  report: Report;
  /** Plugins bb couldn't check for updates. */
  updateCheckFailures?: PluginCheckFailure[];
}) {
  return (
    <>
      {updateCheckFailures.length === 0 ? null : (
        <Section title="Couldn't check for updates">
          {updateCheckFailures.map(({ id, error }) => (
            <Row key={id} id={id}>
              <span title={error}>{error}</span>
            </Row>
          ))}
        </Section>
      )}
      {report.blocked.length === 0 ? null : (
        <Section title="Blocked by engine ranges">
          {report.blocked.map((item) => (
            <Row key={item.id} id={item.id}>
              {item.version}: {item.reasons.join("; ")}
            </Row>
          ))}
        </Section>
      )}
      {report.releaseCheckFailures.length === 0 ? null : (
        <Section title="Couldn't check for newer releases">
          {report.releaseCheckFailures.map(({ id, error }) => (
            <Row key={id} id={id}>
              <span title={error}>{error}</span>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}
