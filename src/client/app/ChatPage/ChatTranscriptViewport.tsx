import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { measureElement, useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, Flower, Upload } from "lucide-react"
import { AnimatedShinyText } from "../../components/ui/animated-shiny-text"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { OpenLocalLinkProvider } from "../../components/messages/shared"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { cn } from "../../lib/utils"
import { buildResolvedTranscriptRows, KannaTranscriptRow } from "../KannaTranscript"
import type { KannaState } from "../useKannaState"
import {
  CHAT_NAVBAR_OFFSET_PX,
  CHAT_SELECTION_AUTOFOLLOW_WINDOW_MS,
  EMPTY_STATE_TEXT,
  SCROLL_BUTTON_BOTTOM_PX,
  estimateTranscriptRowHeight,
  getPinnedTailStartIndex,
  shouldAutoFollowTranscriptResize,
} from "./utils"

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  scrollRef: KannaState["scrollRef"]
  messages: KannaState["messages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: KannaState["latestToolIds"]
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  isProcessing: boolean
  runtimeStatus: string | null
  isDraining: boolean
  commandError: string | null
  loadOlderHistory: () => Promise<void>
  onStopDraining: () => void
  onOpenLocalLink: KannaState["handleOpenLocalLink"]
  onAskUserQuestionSubmit: KannaState["handleAskUserQuestion"]
  onExitPlanModeConfirm: KannaState["handleExitPlanMode"]
  showScrollButton: boolean
  onScrollChange: () => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
  showEmptyState: boolean
}

export const ChatTranscriptViewport = memo(function ChatTranscriptViewport({
  activeChatId,
  scrollRef,
  messages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isHistoryLoading,
  hasOlderHistory,
  isProcessing,
  runtimeStatus,
  isDraining,
  commandError,
  loadOlderHistory,
  onStopDraining,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  showScrollButton,
  onScrollChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
  showEmptyState,
}: ChatTranscriptViewportProps) {
  const contentRootRef = useRef<HTMLDivElement>(null)
  const previousRowCountRef = useRef(0)
  const pendingPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const selectionAutoFollowUntilRef = useRef(0)
  const [transcriptContentWidth, setTranscriptContentWidth] = useState<number | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})

  const resolvedRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
  }), [isProcessing, latestToolIds, localPath, messages])

  const pinnedTailStartIndex = useMemo(
    () => getPinnedTailStartIndex(resolvedRows, isProcessing),
    [isProcessing, resolvedRows]
  )
  const virtualizedHeadRows = useMemo(
    () => resolvedRows.slice(0, pinnedTailStartIndex),
    [pinnedTailStartIndex, resolvedRows]
  )
  const pinnedTailRows = useMemo(
    () => resolvedRows.slice(pinnedTailStartIndex),
    [pinnedTailStartIndex, resolvedRows]
  )
  const virtualMeasurementScopeKey = transcriptContentWidth === null
    ? "width:unknown"
    : `width:${Math.round(transcriptContentWidth)}`
  const handleToolGroupExpandedChange = useCallback((groupId: string, next: boolean) => {
    setToolGroupExpanded((current) => (
      current[groupId] === next
        ? current
        : {
            ...current,
            [groupId]: next,
          }
    ))
  }, [])

  const rowVirtualizer = useVirtualizer({
    count: virtualizedHeadRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => `${virtualMeasurementScopeKey}:${virtualizedHeadRows[index]?.id ?? index}`,
    estimateSize: (index) => estimateTranscriptRowHeight(virtualizedHeadRows[index] ?? pinnedTailRows[0]!),
    measureElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  })

  useEffect(() => {
    selectionAutoFollowUntilRef.current = Date.now() + CHAT_SELECTION_AUTOFOLLOW_WINDOW_MS
  }, [activeChatId])

  useEffect(() => {
    const contentRoot = contentRootRef.current
    if (!contentRoot) return

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return

      const width = rect.width
      setTranscriptContentWidth((current) => {
        const nextWidth = typeof width === "number" ? width : null
        if (nextWidth === null && current === null) return current
        if (nextWidth !== null && current !== null && Math.round(nextWidth) === Math.round(current)) {
          return current
        }
        return nextWidth
      })

      if (
        shouldAutoFollowTranscriptResize(
          showScrollButton,
          selectionAutoFollowUntilRef.current
        )
        && !pendingPrependAnchorRef.current
      ) {
        const scrollContainer = scrollRef.current
        if (scrollContainer) {
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" })
        }
      }
    })

    observer.observe(contentRoot)
    return () => observer.disconnect()
  }, [scrollRef, showScrollButton])

  useEffect(() => {
    if (transcriptContentWidth === null) return
    rowVirtualizer.measure()
  }, [rowVirtualizer, transcriptContentWidth])

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0
      const scrollOffset = instance.scrollOffset ?? 0
      const itemIntersectsViewport = item.end > scrollOffset && item.start < scrollOffset + viewportHeight
      if (itemIntersectsViewport) {
        return false
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight)
      return remainingDistance > 24
    }
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
    }
  }, [rowVirtualizer])

  const requestOlderHistory = useCallback(() => {
    if (isHistoryLoading || !hasOlderHistory) return
    const scrollContainer = scrollRef.current
    if (scrollContainer) {
      pendingPrependAnchorRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
      }
    }
    void loadOlderHistory()
  }, [hasOlderHistory, isHistoryLoading, loadOlderHistory, scrollRef])

  useLayoutEffect(() => {
    const previousCount = previousRowCountRef.current
    const currentCount = resolvedRows.length

    if (pendingPrependAnchorRef.current && !isHistoryLoading) {
      const scrollContainer = scrollRef.current
      if (scrollContainer && currentCount > previousCount) {
        const heightDelta = scrollContainer.scrollHeight - pendingPrependAnchorRef.current.scrollHeight
        scrollContainer.scrollTop = pendingPrependAnchorRef.current.scrollTop + heightDelta
      }
      pendingPrependAnchorRef.current = null
    }

    previousRowCountRef.current = currentCount
  }, [isHistoryLoading, resolvedRows.length, scrollRef])

  useLayoutEffect(() => {
    if (showScrollButton) return
    if (pendingPrependAnchorRef.current) return

    const scrollContainer = scrollRef.current
    if (!scrollContainer) return

    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" })
  }, [activeChatId, isProcessing, resolvedRows.length, scrollRef, showScrollButton, transcriptContentWidth])

  const handleTranscriptScroll = useCallback(() => {
    onScrollChange()
    const scrollContainer = scrollRef.current
    if (!scrollContainer) return
    if (scrollContainer.scrollTop > 0) return
    requestOlderHistory()
  }, [onScrollChange, requestOlderHistory, scrollRef])

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleTranscriptScroll}
        className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 scroll-pt-[72px] [scrollbar-gutter:auto]"
      >
        <div ref={contentRootRef} className="mx-auto w-full max-w-[800px] animate-fade-in pt-[72px]">
          {isHistoryLoading ? (
            <div className="pb-4 flex justify-center">
              <span className="text-sm translate-y-[-0.5px]">
                <AnimatedShinyText
                  animate
                  shimmerWidth={Math.max(20, "Loading more messages...".length * 3)}
                >
                  Loading more messages...
                </AnimatedShinyText>
              </span>
            </div>
          ) : null}
          {messages.length > 0 ? (
            <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
              <>
                {virtualizedHeadRows.length > 0 ? (
                  <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const row = virtualizedHeadRows[virtualRow.index]
                      if (!row) return null

                      return (
                        <div
                          key={`virtual-row:${row.id}`}
                          data-index={virtualRow.index}
                          ref={rowVirtualizer.measureElement}
                          className="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div className="pb-5">
                            <KannaTranscriptRow
                              row={row}
                              toolGroupExpanded={toolGroupExpanded}
                              onToolGroupExpandedChange={handleToolGroupExpandedChange}
                              onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                              onExitPlanModeConfirm={onExitPlanModeConfirm}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {pinnedTailRows.map((row) => (
                  <div key={`tail-row:${row.id}`} className="pb-5">
                    <KannaTranscriptRow
                      row={row}
                      toolGroupExpanded={toolGroupExpanded}
                      onToolGroupExpandedChange={handleToolGroupExpandedChange}
                      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                      onExitPlanModeConfirm={onExitPlanModeConfirm}
                    />
                  </div>
                ))}
              </>
            </OpenLocalLinkProvider>
          ) : (
            <div style={{ height: transcriptPaddingBottom }} aria-hidden="true" />
          )}
          {isProcessing ? <ProcessingMessage status={runtimeStatus ?? undefined} /> : null}
          {!isProcessing && isDraining ? (
            <DrainingIndicator onStop={() => void onStopDraining()} />
          ) : null}
          {commandError ? (
            <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3">
              {commandError}
            </div>
          ) : null}
          <div style={{ height: transcriptPaddingBottom }} aria-hidden="true" />
        </div>
      </div>

      {showEmptyState ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: CHAT_NAVBAR_OFFSET_PX,
            bottom: transcriptPaddingBottom,
          }}
        >
          <div className="mx-auto flex h-full max-w-[800px] items-center justify-center">
            <div className="flex flex-col items-center justify-center text-muted-foreground gap-4 opacity-70">
              <Flower strokeWidth={1.5} className="size-8 text-muted-foreground kanna-empty-state-flower" />
              <div
                className="text-base font-normal text-muted-foreground text-center max-w-xs flex items-center kanna-empty-state-text"
                aria-label={EMPTY_STATE_TEXT}
              >
                <span className="relative inline-grid place-items-start">
                  <span className="invisible col-start-1 row-start-1 whitespace-pre flex items-center">
                    <span>{EMPTY_STATE_TEXT}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true" />
                  </span>
                  <span className="col-start-1 row-start-1 whitespace-pre flex items-center">
                    <span>{typedEmptyStateText}</span>
                    <span className="kanna-typewriter-cursor-slot" aria-hidden="true">
                      <span
                        className="kanna-typewriter-cursor"
                        data-typing-complete={isEmptyStateTypingComplete ? "true" : "false"}
                      />
                    </span>
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="absolute inset-0 z-30 pointer-events-none">
          <div className="absolute inset-0 backdrop-blur-sm" />
          <div className="absolute inset-6 ">
            <div className="flex h-full items-center justify-center">
              <div className="text-center flex flex-col items-center justify-center gap-3">
                <Upload className="mx-auto size-14 text-foreground" strokeWidth={1.75} />
                <div className="text-xl font-medium text-foreground">Drop up to 10 files</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{ bottom: SCROLL_BUTTON_BOTTOM_PX }}
        className={cn(
          "absolute left-1/2 -translate-x-1/2 z-10 transition-all",
          showScrollButton
            ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "scale-60 duration-300 ease-out pointer-events-none blur-sm opacity-0"
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex items-center transition-colors gap-1.5 px-2 bg-white hover:bg-muted border border-border rounded-full aspect-square cursor-pointer text-sm text-primary hover:text-foreground dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 dark:border-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </>
  )
})
