import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorText } from "@/lib/updates";

export function CopyableCommand({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Copy command"
        onClick={() => {
          navigator.clipboard.writeText(command).then(
            () => toast.success("Copied"),
            (cause) => toast.error(errorText(cause)),
          );
        }}
      >
        <Icon name="Copy" className="size-4" />
      </Button>
    </div>
  );
}
