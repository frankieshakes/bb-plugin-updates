import { Button } from "@/components/ui/button";

export function IgnoreButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Ignore
    </Button>
  );
}
