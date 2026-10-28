import type { OutOfRangeEntry } from "../../src/contract";
import type { OutOfRangeItem } from "../../src/report";
import { ExternalLink } from "@/components/ExternalLink";
import { Row, Section } from "@/components/list";
import { IgnoreButton } from "@/components/sections/IgnoreButton";
import { Button } from "@/components/ui/button";

/** Newer releases bb can't reach in place; each update is confirmed first. */
export function OutOfRangeSection({
  items,
  stateFor,
  onUpdate,
  onIgnore,
}: {
  items: OutOfRangeItem[];
  /** The plugin's queued or running update, if any. */
  stateFor: (id: string) => Exclude<OutOfRangeEntry["state"], "done"> | undefined;
  onUpdate: (item: OutOfRangeItem) => void;
  onIgnore: (id: string, version: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Section title="Newer releases outside the installed range">
      {items.map((item) => {
        const state = stateFor(item.id);
        return (
          <Row
            key={item.id}
            id={item.id}
            tag={item.disabled ? "Disabled" : undefined}
            actions={
              <>
                <IgnoreButton onClick={() => onIgnore(item.id, item.version)} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onUpdate(item)}
                  disabled={state !== undefined}
                >
                  {state === "queued" ? "Queued" : state === "running" ? "Updating…" : "Update"}
                </Button>
              </>
            }
          >
            {item.from} → {item.to} · <ExternalLink href={item.compareUrl}>changes</ExternalLink>
          </Row>
        );
      })}
    </Section>
  );
}
