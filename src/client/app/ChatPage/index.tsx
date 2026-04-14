import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import { useOutletContext } from "react-router-dom"
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput"
import { ChatNavbar } from "../../components/chat-ui/ChatNavbar"
import { RightSidebar } from "../../components/chat-ui/RightSidebar"
import { useAppDialog } from "../../components/ui/app-dialog"
import { Card, CardContent } from "../../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable"
import { actionMatchesEvent, getResolvedKeybindings } from "../../lib/keybindings"
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  RIGHT_SIDEBAR_MIN_SIZE_PERCENT,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "../../stores/rightSidebarStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { shouldCloseTerminalPane } from "../terminalLayoutResize"
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "../terminalToggleAnimation"
import { useRightSidebarToggleAnimation } from "../useRightSidebarToggleAnimation"
import { useStickyChatFocus } from "../useStickyChatFocus"
import { useTerminalToggleAnimation } from "../useTerminalToggleAnimation"
import type { KannaState } from "../useKannaState"
import { ChatInputDock } from "./ChatInputDock"
import { ChatTranscriptViewport } from "./ChatTranscriptViewport"
import { TerminalWorkspaceShell } from "./TerminalWorkspaceShell"
import { useChatPageSidebarActions, EMPTY_DIFF_SNAPSHOT } from "./useChatPageSidebarActions"
import {
  EMPTY_STATE_TEXT,
  EMPTY_STATE_TYPING_INTERVAL_MS,
  hasFileDragTypes,
  sameContextWindowSnapshot,
} from "./utils"

export {
  getIgnoreFolderEntryFromDiffPath,
  hasFileDragTypes,
  shouldAutoFollowTranscriptResize,
} from "./utils"

function useEmptyStateTyping(showEmptyState: boolean, activeChatId: string | null) {
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)

  useEffect(() => {
    if (!showEmptyState) return

    setTypedEmptyStateText("")
    setIsEmptyStateTypingComplete(false)

    let characterIndex = 0
    const interval = window.setInterval(() => {
      characterIndex += 1
      setTypedEmptyStateText(EMPTY_STATE_TEXT.slice(0, characterIndex))

      if (characterIndex >= EMPTY_STATE_TEXT.length) {
        window.clearInterval(interval)
        setIsEmptyStateTypingComplete(true)
      }
    }, EMPTY_STATE_TYPING_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [showEmptyState, activeChatId])

  return { typedEmptyStateText, isEmptyStateTypingComplete }
}

function usePageFileDrop(args: {
  hasSelectedProject: boolean
  onFilesDropped: (files: File[]) => void
}) {
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const pageFileDragDepthRef = useRef(0)

  const hasDraggedFiles = useCallback((event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? []), [])

  const handleTranscriptDragEnter = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current += 1
    setIsPageFileDragActive(true)
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDragOver = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!isPageFileDragActive) {
      setIsPageFileDragActive(true)
    }
  }, [args.hasSelectedProject, hasDraggedFiles, isPageFileDragActive])

  const handleTranscriptDragLeave = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
    if (pageFileDragDepthRef.current === 0) {
      setIsPageFileDragActive(false)
    }
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDrop = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
    args.onFilesDropped([...event.dataTransfer.files])
  }, [args, hasDraggedFiles])

  return {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  }
}

function useLayoutWidth(ref: RefObject<HTMLDivElement | null>) {
  const [layoutWidth, setLayoutWidth] = useState(0)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const updateWidth = () => {
      const nextWidth = element.clientWidth
      setLayoutWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    updateWidth()

    return () => observer.disconnect()
  }, [ref])

  return layoutWidth
}

function useFixedTerminalHeight(args: {
  layoutRootRef: RefObject<HTMLDivElement | null>
  shouldRenderTerminalLayout: boolean
  terminalMainSizes: [number, number]
}) {
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0)

  useEffect(() => {
    const element = args.layoutRootRef.current
    if (!element) return

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height

      if (!args.shouldRenderTerminalLayout) {
        return
      }

      if (containerHeight <= 0) return
      const nextHeight = containerHeight * (args.terminalMainSizes[1] / 100)
      if (nextHeight <= 0) return
      setFixedTerminalHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()

    return () => observer.disconnect()
  }, [args.layoutRootRef, args.shouldRenderTerminalLayout, args.terminalMainSizes])

  return fixedTerminalHeight
}

interface ChatWorkspaceProps {
  chatCard: ReactNode
  projectId: string
  shouldRenderTerminalLayout: boolean
  showTerminalPane: boolean
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  mainPanelGroupRef: RefObject<GroupImperativeHandle | null>
  terminalPanelRef: RefObject<HTMLDivElement | null>
  terminalVisualRef: RefObject<HTMLDivElement | null>
  fixedTerminalHeight: number
  terminalFocusRequestVersion: number
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: KannaState["socket"]
  connectionStatus: KannaState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  onTerminalCommandSent?: () => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
  onLayoutChanged: (layout: Record<string, number>) => void
}

function ChatWorkspace({
  chatCard,
  projectId,
  shouldRenderTerminalLayout,
  showTerminalPane,
  terminalLayout,
  mainPanelGroupRef,
  terminalPanelRef,
  terminalVisualRef,
  fixedTerminalHeight,
  terminalFocusRequestVersion,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  onTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
  onLayoutChanged,
}: ChatWorkspaceProps) {
  if (!shouldRenderTerminalLayout) {
    return <>{chatCard}</>
  }

  return (
    <ResizablePanelGroup
      key={projectId}
      groupRef={mainPanelGroupRef}
      orientation="vertical"
      className="flex-1 min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel id="chat" defaultSize={`${terminalLayout.mainSizes[0]}%`} minSize="25%" className="min-h-0">
        {chatCard}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        orientation="vertical"
        disabled={!showTerminalPane}
        className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
      />
      <ResizablePanel
        id="terminal"
        defaultSize={`${terminalLayout.mainSizes[1]}%`}
        minSize="0%"
        className="min-h-0"
        elementRef={terminalPanelRef}
      >
        <div
          ref={terminalVisualRef}
          className="h-full min-h-0 overflow-hidden relative"
          data-terminal-open={showTerminalPane ? "true" : "false"}
          data-terminal-animated="false"
          data-terminal-visual
          style={{
            "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
          } as CSSProperties}
        >
          <TerminalWorkspaceShell
            projectId={projectId}
            fixedTerminalHeight={fixedTerminalHeight}
            terminalLayout={terminalLayout}
            addTerminal={addTerminal}
            socket={socket}
            connectionStatus={connectionStatus}
            scrollback={scrollback}
            minColumnWidth={minColumnWidth}
            splitTerminalShortcut={splitTerminalShortcut}
            focusRequestVersion={terminalFocusRequestVersion}
            onTerminalCommandSent={onTerminalCommandSent}
            onRemoveTerminal={onRemoveTerminal}
            onTerminalLayout={onTerminalLayout}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

export function ChatPage() {
  const state = useOutletContext<KannaState>()
  const dialog = useAppDialog()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const showEmptyState = state.messages.length === 0 && state.runtime?.title === "New Chat"
  const projectId = state.activeProjectId
  const projectTerminalLayout = useTerminalLayoutStore((store) => (projectId ? store.projects[projectId] : undefined))
  const terminalLayout = projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
  const projectRightSidebarVisibility = useRightSidebarStore((store) => (projectId ? store.projects[projectId] : undefined))
  const rightSidebarVisibility = projectRightSidebarVisibility ?? DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE
  const globalRightSidebarSize = useRightSidebarStore((store) => store.size)
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const toggleVisibility = useTerminalLayoutStore((store) => store.toggleVisibility)
  const resetMainSizes = useTerminalLayoutStore((store) => store.resetMainSizes)
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const toggleRightSidebar = useRightSidebarStore((store) => store.toggleVisibility)
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const baseContextWindowSnapshotRef = useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(state.chatSnapshot?.messages ?? [])
    const previousSnapshot = baseContextWindowSnapshotRef.current
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot
    return derivedSnapshot
  }, [state.chatSnapshot?.messages])

  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && terminalLayout.isVisible && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const showRightSidebar = Boolean(projectId && rightSidebarVisibility.isVisible)
  const shouldRenderRightSidebarLayout = Boolean(projectId)
  const layoutWidth = useLayoutWidth(layoutRootRef)
  const clampRightSidebarSize = useCallback((size: number, widthOverride?: number) => {
    if (!Number.isFinite(size)) {
      return globalRightSidebarSize
    }
    const nextLayoutWidth = widthOverride ?? layoutWidth
    const minPercentFromWidth = nextLayoutWidth > 0
      ? (RIGHT_SIDEBAR_MIN_WIDTH_PX / nextLayoutWidth) * 100
      : RIGHT_SIDEBAR_MIN_SIZE_PERCENT
    return Math.max(RIGHT_SIDEBAR_MIN_SIZE_PERCENT, minPercentFromWidth, size)
  }, [globalRightSidebarSize, layoutWidth])
  const effectiveRightSidebarSize = clampRightSidebarSize(globalRightSidebarSize ?? DEFAULT_RIGHT_SIDEBAR_SIZE)
  const fixedTerminalHeight = useFixedTerminalHeight({
    layoutRootRef,
    shouldRenderTerminalLayout,
    terminalMainSizes: terminalLayout.mainSizes,
  })

  const {
    isAnimating: isTerminalAnimating,
    mainPanelGroupRef,
    terminalFocusRequestVersion,
    terminalPanelRef,
    terminalVisualRef,
  } = useTerminalToggleAnimation({
    showTerminalPane,
    shouldRenderTerminalLayout,
    projectId,
    terminalLayout,
    chatInputRef: chatInputElementRef,
  })
  const {
    isAnimating: isRightSidebarAnimating,
    panelGroupRef: rightSidebarPanelGroupRef,
    sidebarPanelRef,
    sidebarVisualRef,
  } = useRightSidebarToggleAnimation({
    projectId,
    shouldRenderRightSidebarLayout,
    showRightSidebar,
    rightSidebarSize: effectiveRightSidebarSize,
  })

  const {
    diffRenderMode,
    wrapDiffLines,
    setDiffRenderMode,
    setWrapDiffLines,
    scheduleTerminalDiffRefresh,
    handleOpenDiffFile,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleOpenDiffInFinder,
    handleCommitDiffs,
    handleSyncBranch,
    handleGenerateCommitMessage,
    handleInitializeGit,
    handleGetGitHubPublishInfo,
    handleCheckGitHubRepoAvailability,
    handleSetupGitHub,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  } = useChatPageSidebarActions({
    state,
    projectId,
    showRightSidebar,
  })

  const { typedEmptyStateText, isEmptyStateTypingComplete } = useEmptyStateTyping(showEmptyState, state.activeChatId)

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject && state.runtime?.status !== "waiting_for_user",
    canCancel: state.canCancel,
  })

  const enqueueDroppedFiles = useCallback((files: File[]) => {
    if (!state.hasSelectedProject || files.length === 0) {
      return
    }
    chatInputRef.current?.enqueueFiles(files)
  }, [state.hasSelectedProject])

  const {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  } = usePageFileDrop({
    hasSelectedProject: state.hasSelectedProject,
    onFilesDropped: enqueueDroppedFiles,
  })

  const handleToggleEmbeddedTerminal = useCallback(() => {
    if (!projectId) return
    if (hasTerminals) {
      toggleVisibility(projectId)
      return
    }

    addTerminal(projectId)
  }, [addTerminal, hasTerminals, projectId, toggleVisibility])

  const handleTerminalResize = useCallback((layout: Record<string, number>) => {
    if (!projectId || !showTerminalPane || isTerminalAnimating.current) {
      return
    }

    const chatSize = layout.chat
    const terminalSize = layout.terminal
    if (!Number.isFinite(chatSize) || !Number.isFinite(terminalSize)) {
      return
    }

    const containerHeight = layoutRootRef.current?.getBoundingClientRect().height ?? 0
    if (shouldCloseTerminalPane(containerHeight, terminalSize)) {
      resetMainSizes(projectId)
      toggleVisibility(projectId)
      return
    }

    setMainSizes(projectId, [chatSize, terminalSize])
  }, [isTerminalAnimating, projectId, resetMainSizes, setMainSizes, showTerminalPane, toggleVisibility])

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return
    toggleRightSidebar(projectId)
  }, [projectId, toggleRightSidebar])

  const handleToggleRightSidebar = useCallback(() => {
    if (!projectId) return

    if (showRightSidebar) {
      toggleRightSidebar(projectId)
      return
    }

    if (state.chatDiffSnapshot?.status === "no_repo") {
      void (async () => {
        const confirmed = await dialog.confirm({
          title: "Initialize Git?",
          description: "Initialize a local git repository in this project?",
          confirmLabel: "Init Git",
          cancelLabel: "Cancel",
        })
        if (!confirmed) return

        const result = await handleInitializeGit()
        if (result?.ok && !showRightSidebar) {
          toggleRightSidebar(projectId)
        }
      })()
      return
    }

    toggleRightSidebar(projectId)
  }, [dialog, handleInitializeGit, projectId, showRightSidebar, state.chatDiffSnapshot?.status, toggleRightSidebar])

  const handleCancel = useCallback(() => {
    void state.handleCancel()
  }, [state.handleCancel])

  const handleOpenExternal = useCallback((action: "open_finder" | "open_editor" | "open_terminal") => {
    void state.handleOpenExternal(action)
  }, [state.handleOpenExternal])

  const handleRemoveTerminal = useCallback((currentProjectId: string, terminalId: string) => {
    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(currentProjectId, terminalId)
  }, [removeTerminal, state.socket])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!projectId) return
      if (actionMatchesEvent(resolvedKeybindings, "toggleEmbeddedTerminal", event)) {
        event.preventDefault()
        handleToggleEmbeddedTerminal()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "toggleRightSidebar", event)) {
        event.preventDefault()
        handleToggleRightSidebar()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInFinder", event)) {
        event.preventDefault()
        void state.handleOpenExternal("open_finder")
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInEditor", event)) {
        event.preventDefault()
        void state.handleOpenExternal("open_editor")
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "addSplitTerminal", event)) {
        event.preventDefault()
        addTerminal(projectId)
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [addTerminal, handleToggleEmbeddedTerminal, handleToggleRightSidebar, projectId, resolvedKeybindings, state.handleOpenExternal])

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      state.updateScrollState()
    })
    const timeoutId = window.setTimeout(() => {
      state.updateScrollState()
    }, TERMINAL_TOGGLE_ANIMATION_DURATION_MS)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [shouldRenderTerminalLayout, showTerminalPane, state.updateScrollState])

  useEffect(() => {
    function handleResize() {
      state.updateScrollState()
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [state.updateScrollState])

  useLayoutEffect(() => {
    if (!showRightSidebar || layoutWidth <= 0 || isRightSidebarAnimating.current) {
      return
    }

    const clampedRightSidebarSize = clampRightSidebarSize(globalRightSidebarSize, layoutWidth)
    const currentLayout = rightSidebarPanelGroupRef.current?.getLayout()
    if (!currentLayout) return
    if (Math.abs((currentLayout.rightSidebar ?? 0) - clampedRightSidebarSize) < 0.1) {
      return
    }

    rightSidebarPanelGroupRef.current?.setLayout({
      workspace: 100 - clampedRightSidebarSize,
      rightSidebar: clampedRightSidebarSize,
    })
  }, [
    clampRightSidebarSize,
    globalRightSidebarSize,
    isRightSidebarAnimating,
    layoutWidth,
    rightSidebarPanelGroupRef,
    showRightSidebar,
  ])

  const chatCard = (
    <Card
      ref={chatCardRef}
      className="bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative"
      onDragEnter={handleTranscriptDragEnter}
      onDragOver={handleTranscriptDragOver}
      onDragLeave={handleTranscriptDragLeave}
      onDrop={handleTranscriptDrop}
    >
      <CardContent className="flex flex-1 min-h-0 flex-col p-0 overflow-hidden relative">
        <ChatNavbar
          sidebarCollapsed={state.sidebarCollapsed}
          onOpenSidebar={state.openSidebar}
          onExpandSidebar={state.expandSidebar}
          onNewChat={state.handleCompose}
          localPath={state.navbarLocalPath}
          embeddedTerminalVisible={showTerminalPane}
          onToggleEmbeddedTerminal={projectId ? handleToggleEmbeddedTerminal : undefined}
          rightSidebarVisible={showRightSidebar}
          onToggleRightSidebar={projectId ? handleToggleRightSidebar : undefined}
          onOpenExternal={handleOpenExternal}
          editorLabel={state.editorLabel}
          finderShortcut={resolvedKeybindings.bindings.openInFinder}
          editorShortcut={resolvedKeybindings.bindings.openInEditor}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
          branchName={state.chatDiffSnapshot?.branchName}
          hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
          gitStatus={state.chatDiffSnapshot?.status}
        />
        <ChatTranscriptViewport
          activeChatId={state.activeChatId}
          scrollRef={state.scrollRef}
          messages={state.messages}
          transcriptPaddingBottom={state.transcriptPaddingBottom}
          localPath={state.runtime?.localPath}
          latestToolIds={state.latestToolIds}
          isHistoryLoading={state.isHistoryLoading}
          hasOlderHistory={state.hasOlderHistory}
          isProcessing={state.isProcessing}
          runtimeStatus={state.runtimeStatus}
          isDraining={state.isDraining}
          commandError={state.commandError}
          loadOlderHistory={state.loadOlderHistory}
          onStopDraining={state.handleStopDraining}
          onOpenLocalLink={state.handleOpenLocalLink}
          onAskUserQuestionSubmit={state.handleAskUserQuestion}
          onExitPlanModeConfirm={state.handleExitPlanMode}
          showScrollButton={state.showScrollButton}
          onScrollChange={state.updateScrollState}
          scrollToBottom={state.scrollToBottom}
          typedEmptyStateText={typedEmptyStateText}
          isEmptyStateTypingComplete={isEmptyStateTypingComplete}
          isPageFileDragActive={isPageFileDragActive}
          showEmptyState={showEmptyState}
        />
      </CardContent>

      <ChatInputDock
        inputRef={state.inputRef}
        chatInputRef={chatInputRef}
        chatInputElementRef={chatInputElementRef}
        activeChatId={state.activeChatId}
        previousPrompt={state.previousPrompt}
        hasSelectedProject={state.hasSelectedProject}
        runtimeStatus={state.runtimeStatus}
        canCancel={state.canCancel}
        projectId={projectId}
        activeProvider={state.runtime?.provider ?? null}
        availableProviders={state.availableProviders}
        contextWindowSnapshot={contextWindowSnapshot}
        onSubmit={state.handleSend}
        onCancel={handleCancel}
      />
    </Card>
  )

  const workspace = projectId ? (
    <ChatWorkspace
      chatCard={chatCard}
      projectId={projectId}
      shouldRenderTerminalLayout={shouldRenderTerminalLayout}
      showTerminalPane={showTerminalPane}
      terminalLayout={terminalLayout}
      mainPanelGroupRef={mainPanelGroupRef}
      terminalPanelRef={terminalPanelRef}
      terminalVisualRef={terminalVisualRef}
      fixedTerminalHeight={fixedTerminalHeight}
      terminalFocusRequestVersion={terminalFocusRequestVersion}
      addTerminal={addTerminal}
      socket={state.socket}
      connectionStatus={state.connectionStatus}
      scrollback={scrollback}
      minColumnWidth={minColumnWidth}
      splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
      onTerminalCommandSent={scheduleTerminalDiffRefresh}
      onRemoveTerminal={handleRemoveTerminal}
      onTerminalLayout={setTerminalSizes}
      onLayoutChanged={handleTerminalResize}
    />
  ) : (
    chatCard
  )

  return (
    <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
      {shouldRenderRightSidebarLayout && projectId ? (
        <ResizablePanelGroup
          key={`${projectId}-right-sidebar`}
          groupRef={rightSidebarPanelGroupRef}
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChange={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            const clampedRightSidebarSize = clampRightSidebarSize(layout.rightSidebar)
            if (Math.abs(clampedRightSidebarSize - layout.rightSidebar) < 0.1) {
              return
            }

            rightSidebarPanelGroupRef.current?.setLayout({
              workspace: 100 - clampedRightSidebarSize,
              rightSidebar: clampedRightSidebarSize,
            })
          }}
          onLayoutChanged={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            setRightSidebarSize(clampRightSidebarSize(layout.rightSidebar))
          }}
        >
          <ResizablePanel
            id="workspace"
            defaultSize={`${100 - effectiveRightSidebarSize}%`}
            minSize="20%"
            className="min-h-0 min-w-0"
          >
            {workspace}
          </ResizablePanel>
          <ResizableHandle
            withHandle={false}
            orientation="horizontal"
            disabled={!showRightSidebar}
            className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
          />
          <ResizablePanel
            id="rightSidebar"
            defaultSize={`${effectiveRightSidebarSize}%`}
            className="min-h-0 min-w-0"
            elementRef={sidebarPanelRef}
          >
            <div
              ref={sidebarVisualRef}
              className="h-full min-h-0 overflow-hidden"
              data-right-sidebar-open={showRightSidebar ? "true" : "false"}
              data-right-sidebar-animated="false"
              data-right-sidebar-visual
              style={{
                "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
              } as CSSProperties}
            >
              <RightSidebar
                projectId={projectId}
                diffs={state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT}
                editorLabel={state.editorLabel}
                diffRenderMode={diffRenderMode}
                wrapLines={wrapDiffLines}
                onOpenFile={handleOpenDiffFile}
                onOpenInFinder={handleOpenDiffInFinder}
                onDiscardFile={handleDiscardDiffFile}
                onIgnoreFile={handleIgnoreDiffFile}
                onIgnoreFolder={handleIgnoreDiffFolder}
                onCopyFilePath={handleCopyDiffFilePath}
                onCopyRelativePath={handleCopyDiffRelativePath}
                onLoadPatch={handleLoadDiffPatch}
                onListBranches={handleListBranches}
                onPreviewMergeBranch={handlePreviewMergeBranch}
                onMergeBranch={handleMergeBranch}
                onCheckoutBranch={handleCheckoutBranch}
                onCreateBranch={handleCreateBranch}
                onGenerateCommitMessage={handleGenerateCommitMessage}
                onInitializeGit={handleInitializeGit}
                onGetGitHubPublishInfo={handleGetGitHubPublishInfo}
                onCheckGitHubRepoAvailability={handleCheckGitHubRepoAvailability}
                onSetupGitHub={handleSetupGitHub}
                onCommit={handleCommitDiffs}
                onSyncWithRemote={handleSyncBranch}
                onDiffRenderModeChange={setDiffRenderMode}
                onWrapLinesChange={setWrapDiffLines}
                onClose={handleCloseRightSidebar}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        workspace
      )}
    </div>
  )
}
