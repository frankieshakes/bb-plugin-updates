import type { CompatibleItem } from "../../src/report";
import { Row, Section } from "@/components/list";
import { IgnoreButton } from "@/components/sections/IgnoreButton";
import { Button } from "@/components/ui/button";

/**
 * Updates bb applies in place; one job each, or all at once (enabled plugins
 * only). A plugin with an out-of-range update pending waits for it first.
 */
export function CompatibleSection({
  items,
  isUpdating,
  isWaiting,
  onUpdate,
  onUpdateAll,
  onIgnore,
}: {
  items: CompatibleItem[];
  isUpdating: (id: string) => boolean;
  isWaiting: (id: string) => boolean;
  onUpdate: (id: string) => void;
  onUpdateAll: () => void;
  onIgnore: (id: string, version: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Section
      title="Compatible updates"
      action={
        items.filter((i) => !i.disabled).length > 1 ? (
          <Button size="sm" onClick={onUpdateAll}>
            Update all
          </Button>
        ) : undefined
      }
    >
      {items.map((item) => {
        const updating = isUpdating(item.id);
        const waiting = !updating && isWaiting(item.id);
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
                  onClick={() => onUpdate(item.id)}
                  disabled={updating || waiting}
                >
                  {updating ? "Updating…" : waiting ? "Waiting…" : "Update"}
                </Button>
              </>
            }
          >
            {item.from} → {item.to}
          </Row>
        );
      })}
    </Section>
  );
}
