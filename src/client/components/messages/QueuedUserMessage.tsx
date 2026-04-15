import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { QueuedChatMessage } from "../../../shared/types"
import { Button } from "../ui/button"
import { createMarkdownComponents } from "./shared"

interface QueuedUserMessageProps {
  message: QueuedChatMessage
  onRemove: () => void
  onSendNow: () => void
}

export function QueuedUserMessage({ message, onRemove, onSendNow }: QueuedUserMessageProps) {
  return (
    <div className="flex justify-end py-2">
      <div className="flex max-w-[85%] sm:max-w-[80%] flex-col items-end gap-2 text-right">
        {message.attachments.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2">
            {message.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="max-w-[220px] rounded-xl border border-dotted border-border bg-transparent px-3 py-2 text-left"
              >
                <div className="truncate text-[13px] font-medium text-foreground">{attachment.displayName}</div>
                <div className="truncate text-[11px] text-muted-foreground">{attachment.mimeType}</div>
              </div>
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="rounded-[20px] border border-dotted border-border bg-transparent px-3.5 py-1.5 prose prose-sm prose-invert text-primary [&_p]:whitespace-pre-line">
            <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{message.content}</Markdown>
          </div>
        ) : null}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="none"
            size="none"
            className="h-auto p-0 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={onRemove}
          >
            Remove
          </Button>
          <span aria-hidden="true" className="text-[10px] text-muted-foreground/70">|</span>
          <Button
            type="button"
            variant="none"
            size="none"
            className="h-auto p-0 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={onSendNow}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
