import { memo, type RefObject } from "react"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { KannaState } from "../useKannaState"

interface ChatInputDockProps {
  inputRef: RefObject<HTMLDivElement | null>
  chatInputRef: RefObject<ChatInputHandle | null>
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>
  activeChatId: string | null
  previousPrompt: string | null
  hasSelectedProject: boolean
  runtimeStatus: string | null
  canCancel: boolean
  projectId: string | null
  activeProvider: "claude" | "codex" | null
  availableProviders: KannaState["availableProviders"]
  contextWindowSnapshot: ContextWindowSnapshot | null
  onSubmit: KannaState["handleSend"]
  onCancel: () => void
}

export const ChatInputDock = memo(function ChatInputDock({
  inputRef,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  previousPrompt,
  hasSelectedProject,
  runtimeStatus,
  canCancel,
  projectId,
  activeProvider,
  availableProviders,
  contextWindowSnapshot,
  onSubmit,
  onCancel,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={inputRef}>
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          key={activeChatId ?? "new-chat"}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={!hasSelectedProject || runtimeStatus === "waiting_for_user"}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          availableProviders={availableProviders}
          contextWindowSnapshot={contextWindowSnapshot}
          previousPrompt={previousPrompt}
        />
      </div>
    </div>
  )
})
