import type { Report } from "../../src/report";
import { Row, Section } from "@/components/list";

/** Things the user can't act on here: blocked releases and failed release checks. */
export function NoticeSections({ report }: { report: Report }) {
  return (
    <>
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
