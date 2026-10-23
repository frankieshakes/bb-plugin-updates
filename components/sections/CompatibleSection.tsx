import type { CompatibleItem } from "../../src/report";
import { Row, Section } from "@/components/list";
import { IgnoreButton } from "@/components/sections/IgnoreButton";
import { Button } from "@/components/ui/button";

/** Updates bb applies in place; one job each, or all at once. */
export function CompatibleSection({
  items,
  isUpdating,
  onUpdate,
  onUpdateAll,
  onIgnore,
}: {
  items: CompatibleItem[];
  isUpdating: (id: string) => boolean;
  onUpdate: (id: string) => void;
  onUpdateAll: () => void;
  onIgnore: (id: string, version: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Section
      title="Compatible updates"
      action={
        items.length > 1 ? (
          <Button size="sm" onClick={onUpdateAll}>
            Update all
          </Button>
        ) : undefined
      }
    >
      {items.map((item) => (
        <Row
          key={item.id}
          id={item.id}
          actions={
            <>
              <IgnoreButton onClick={() => onIgnore(item.id, item.version)} />
              <Button size="sm" onClick={() => onUpdate(item.id)} disabled={isUpdating(item.id)}>
                {isUpdating(item.id) ? "Updating…" : "Update"}
              </Button>
            </>
          }
        >
          {item.from} → {item.to}
        </Row>
      ))}
    </Section>
  );
}
