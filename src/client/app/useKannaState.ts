import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useNavigate } from "react-router-dom"
import { APP_NAME } from "../../shared/branding"
import { PROVIDERS, type AgentProvider, type AskUserQuestionAnswerMap, type KeybindingsSnapshot, type ModelOptions, type ProviderCatalogEntry, type UpdateInstallResult, type UpdateSnapshot } from "../../shared/types"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { getEditorPresetLabel, useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { ChatSnapshot, LocalProjectsSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"
import type { AskUserQuestionItem } from "../components/messages/types"
import { useAppDialog } from "../components/ui/app-dialog"
import { processTranscriptMessages } from "../lib/parseTranscript"
import { requestNotificationPermissionOnUserAction, shouldShowCompletionNotification, showChatCompletionNotification } from "../pwa"
import { canCancelStatus, getLatestToolIds, isProcessingStatus } from "./derived"
import { KannaSocket, type SocketStatus } from "./socket"
import type { ChatEvent } from "../../shared/protocol"

function getSidebarChatStatusMap(projectGroups: SidebarData["projectGroups"]) {
  const statuses = new Map<string, SidebarChatRow["status"]>()
  for (const group of projectGroups) {
    for (const chat of group.chats) {
      statuses.set(chat.chatId, chat.status)
    }
  }
  return statuses
}

export function reconcileUnreadCompletedChatIds(params: {
  previousStatuses: ReadonlyMap<string, SidebarChatRow["status"]>
  projectGroups: SidebarData["projectGroups"]
  activeChatId: string | null
  unreadCompletedChatIds: ReadonlySet<string>
  pendingCompletionChatIds?: ReadonlySet<string>
  observedRunningPendingChatIds?: ReadonlySet<string>
  lastSeenMessageAtByChatId?: ReadonlyMap<string, number>
}) {
  const nextUnreadCompletedChatIds = new Set(params.unreadCompletedChatIds)
  const currentChatIds = new Set<string>()

  for (const group of params.projectGroups) {
    for (const chat of group.chats) {
      currentChatIds.add(chat.chatId)

      const previousStatus = params.previousStatuses.get(chat.chatId)
      const completedInBackground = (previousStatus === "starting" || previousStatus === "running") && chat.status === "idle"
      const completedPendingTurn = params.pendingCompletionChatIds?.has(chat.chatId)
        && params.observedRunningPendingChatIds?.has(chat.chatId)
        && chat.status === "idle"
      const seenMessageAt = params.lastSeenMessageAtByChatId?.get(chat.chatId) ?? 0
      const hasUnreadCompletedTurnsSinceLastOpen = chat.status === "idle"
        && typeof chat.lastCompletedTurnAt === "number"
        && chat.lastCompletedTurnAt > seenMessageAt
      if ((completedInBackground || completedPendingTurn || hasUnreadCompletedTurnsSinceLastOpen) && chat.chatId !== params.activeChatId) {
        nextUnreadCompletedChatIds.add(chat.chatId)
      }

      if (chat.chatId === params.activeChatId) {
        nextUnreadCompletedChatIds.delete(chat.chatId)
      }
    }
  }

  for (const chatId of nextUnreadCompletedChatIds) {
    if (!currentChatIds.has(chatId)) {
      nextUnreadCompletedChatIds.delete(chatId)
    }
  }

  return nextUnreadCompletedChatIds
}

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

function useKannaSocket() {
  const socketRef = useRef<KannaSocket | null>(null)
  if (!socketRef.current) {
    socketRef.current = new KannaSocket(wsUrl())
  }

  useEffect(() => {
    const socket = socketRef.current
    socket?.start()
    return () => {
      socket?.dispose()
    }
  }, [])

  return socketRef.current as KannaSocket
}

function logKannaState(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[useKannaState] ${message}`)
    return
  }

  console.info(`[useKannaState] ${message}`, details)
}

export function shouldPinTranscriptToBottom(distanceFromBottom: number) {
  return distanceFromBottom < 120
}

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_reconnect" | "navigate_changelog" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_reconnect"
  }

  if (phase === "awaiting_reconnect" && connectionStatus === "connected") {
    return "navigate_changelog"
  }

  return "none"
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

const MIN_TRANSCRIPT_PADDING_BOTTOM = 320
const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"
const CHAT_LAST_SEEN_STORAGE_KEY = "kanna:chat-last-seen-completed-turn-at"

function getUiUpdateRestartPhase() {
  return window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function setUiUpdateRestartPhase(phase: "awaiting_disconnect" | "awaiting_reconnect") {
  window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
}

function clearUiUpdateRestartPhase() {
  window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function readLastSeenMessageAtByChatId() {
  if (typeof window === "undefined") return new Map<string, number>()

  try {
    const raw = window.localStorage.getItem(CHAT_LAST_SEEN_STORAGE_KEY)
    if (!raw) return new Map<string, number>()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const entries = Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    return new Map(entries)
  } catch {
    return new Map<string, number>()
  }
}

function writeLastSeenMessageAtByChatId(lastSeenMessageAtByChatId: ReadonlyMap<string, number>) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(
      CHAT_LAST_SEEN_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(lastSeenMessageAtByChatId.entries()))
    )
  } catch {
    // Ignore storage failures.
  }
}

export interface ProjectRequest {
  mode: "new" | "existing"
  localPath: string
  title: string
}

export type StartChatIntent =
  | { kind: "project_id"; projectId: string }
  | { kind: "local_path"; localPath: string }
  | { kind: "project_request"; project: ProjectRequest }

export function resolveComposeIntent(params: {
  selectedProjectId: string | null
  sidebarProjectId?: string | null
  fallbackLocalProjectPath?: string | null
}): StartChatIntent | null {
  const projectId = params.selectedProjectId ?? params.sidebarProjectId ?? null
  if (projectId) {
    return { kind: "project_id", projectId }
  }

  if (params.fallbackLocalProjectPath) {
    return { kind: "local_path", localPath: params.fallbackLocalProjectPath }
  }

  return null
}

export function getActiveChatSnapshot(chatSnapshot: ChatSnapshot | null, activeChatId: string | null): ChatSnapshot | null {
  if (!chatSnapshot) return null
  if (!activeChatId) return null
  if (chatSnapshot.runtime.chatId !== activeChatId) {
    logKannaState("stale snapshot masked", {
      routeChatId: activeChatId,
      snapshotChatId: chatSnapshot.runtime.chatId,
      snapshotProvider: chatSnapshot.runtime.provider,
    })
    return null
  }
  return chatSnapshot
}

function upsertChatSnapshot(
  previous: Record<string, ChatSnapshot>,
  chatId: string,
  snapshot: ChatSnapshot | null
): Record<string, ChatSnapshot> {
  if (!snapshot) {
    if (!(chatId in previous)) return previous
    const { [chatId]: _removed, ...rest } = previous
    return rest
  }

  if (previous[chatId] === snapshot) return previous
  return {
    ...previous,
    [chatId]: snapshot,
  }
}

function applyChatEventToCache(
  previous: Record<string, ChatSnapshot>,
  activeChatId: string,
  event: ChatEvent
): Record<string, ChatSnapshot> {
  const current = previous[activeChatId]
  if (!current) {
    if (event.type === "chat.reset") {
      return upsertChatSnapshot(previous, activeChatId, event.snapshot)
    }
    return previous
  }

  switch (event.type) {
    case "chat.reset":
      return upsertChatSnapshot(previous, activeChatId, event.snapshot)
    case "chat.runtime":
      return {
        ...previous,
        [activeChatId]: {
          ...current,
          runtime: event.runtime,
        },
      }
    case "chat.messageAppended":
      return {
        ...previous,
        [activeChatId]: {
          ...current,
          messages: [...current.messages, event.entry],
          oldestLoadedMessageId: current.oldestLoadedMessageId ?? event.entry._id,
        },
      }
  }
}

function prependChatSnapshotChunk(
  previous: Record<string, ChatSnapshot>,
  chatId: string,
  snapshot: ChatSnapshot | null
): Record<string, ChatSnapshot> {
  if (!snapshot) return previous
  const current = previous[chatId]
  if (!current) {
    return upsertChatSnapshot(previous, chatId, snapshot)
  }

  if (snapshot.messages.length === 0) {
    return {
      ...previous,
      [chatId]: {
        ...current,
        hasOlderMessages: snapshot.hasOlderMessages,
        oldestLoadedMessageId: current.oldestLoadedMessageId,
      },
    }
  }

  const existingIds = new Set(current.messages.map((entry) => entry._id))
  const prepended = snapshot.messages.filter((entry) => !existingIds.has(entry._id))
  if (prepended.length === 0 && current.hasOlderMessages === snapshot.hasOlderMessages) {
    return previous
  }

  return {
    ...previous,
    [chatId]: {
      ...current,
      runtime: snapshot.runtime,
      messages: [...prepended, ...current.messages],
      hasOlderMessages: snapshot.hasOlderMessages,
      oldestLoadedMessageId: snapshot.oldestLoadedMessageId ?? current.oldestLoadedMessageId,
      availableProviders: snapshot.availableProviders,
    },
  }
}

function getRecentSidebarChatIds(projectGroups: SidebarData["projectGroups"], limit: number): string[] {
  return projectGroups
    .flatMap((group) => group.chats)
    .sort((a, b) => {
      const aTime = a.lastMessageAt ?? a._creationTime
      const bTime = b.lastMessageAt ?? b._creationTime
      return bTime - aTime
    })
    .slice(0, limit)
    .map((chat) => chat.chatId)
}

export interface KannaState {
  socket: KannaSocket
  activeChatId: string | null
  sidebarData: SidebarData
  localProjects: LocalProjectsSnapshot | null
  updateSnapshot: UpdateSnapshot | null
  chatSnapshot: ChatSnapshot | null
  keybindings: KeybindingsSnapshot | null
  connectionStatus: SocketStatus
  sidebarReady: boolean
  localProjectsReady: boolean
  commandError: string | null
  startingLocalPath: string | null
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLDivElement | null>
  messages: ReturnType<typeof processTranscriptMessages>
  latestToolIds: ReturnType<typeof getLatestToolIds>
  runtime: ChatSnapshot["runtime"] | null
  availableProviders: ProviderCatalogEntry[]
  unreadCompletedChatIds: ReadonlySet<string>
  isProcessing: boolean
  canCancel: boolean
  hasOlderMessages: boolean
  loadingOlderMessages: boolean
  transcriptPaddingBottom: number
  showScrollButton: boolean
  navbarLocalPath?: string
  editorLabel: string
  hasSelectedProject: boolean
  openSidebar: () => void
  closeSidebar: () => void
  collapseSidebar: () => void
  expandSidebar: () => void
  updateScrollState: () => void
  scrollToBottom: () => void
  handleCreateChat: (projectId: string) => Promise<void>
  handleOpenLocalProject: (localPath: string) => Promise<void>
  handleCreateProject: (project: ProjectRequest) => Promise<void>
  handleCheckForUpdates: (options?: { force?: boolean }) => Promise<void>
  handleInstallUpdate: () => Promise<void>
  handleSend: (content: string, options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }) => Promise<void>
  handleCancel: () => Promise<void>
  handleLoadOlderMessages: () => Promise<void>
  handleDeleteChat: (chat: SidebarChatRow) => Promise<void>
  handleRemoveProject: (projectId: string) => Promise<void>
  handleOpenExternal: (action: "open_finder" | "open_terminal" | "open_editor") => Promise<void>
  handleOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => Promise<void>
  handleOpenLocalLink: (target: { path: string; line?: number; column?: number }) => Promise<void>
  handleCompose: () => void
  handleAskUserQuestion: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => Promise<void>
  handleExitPlanMode: (
    toolUseId: string,
    confirmed: boolean,
    clearContext?: boolean,
    message?: string
  ) => Promise<void>
}

export function useKannaState(activeChatId: string | null): KannaState {
  const navigate = useNavigate()
  const socket = useKannaSocket()
  const dialog = useAppDialog()

  const [sidebarData, setSidebarData] = useState<SidebarData>({ projectGroups: [] })
  const [localProjects, setLocalProjects] = useState<LocalProjectsSnapshot | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const [chatSnapshotsById, setChatSnapshotsById] = useState<Record<string, ChatSnapshot>>({})
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [sidebarReady, setSidebarReady] = useState(false)
  const [localProjectsReady, setLocalProjectsReady] = useState(false)
  const [chatReady, setChatReady] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [inputHeight, setInputHeight] = useState(148)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [startingLocalPath, setStartingLocalPath] = useState<string | null>(null)
  const [pendingChatId, setPendingChatId] = useState<string | null>(null)
  const [unreadCompletedChatIds, setUnreadCompletedChatIds] = useState<Set<string>>(new Set())
  const editorLabel = getEditorPresetLabel(useTerminalPreferencesStore((store) => store.editorPreset))

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const pendingPrependScrollHeightRef = useRef<number | null>(null)
  const autoFollowTranscriptRef = useRef(true)
  const initialScrollCompletedRef = useRef(false)
  const initialScrollFrameRef = useRef<number | null>(null)
  const initialScrollTimeoutRef = useRef<number | null>(null)
  const previousSidebarStatusesRef = useRef<ReadonlyMap<string, SidebarChatRow["status"]>>(new Map())
  const activeChatIdRef = useRef<string | null>(activeChatId)
  const pendingNotificationChatIdsRef = useRef<Set<string>>(new Set())
  const observedRunningPendingChatIdsRef = useRef<Set<string>>(new Set())
  const lastSeenMessageAtByChatIdRef = useRef<ReadonlyMap<string, number>>(readLastSeenMessageAtByChatId())
  const processedTranscriptCacheRef = useRef(new Map<string, {
    source: ChatSnapshot["messages"]
    messages: ReturnType<typeof processTranscriptMessages>
    latestToolIds: ReturnType<typeof getLatestToolIds>
  }>())
  const prewarmingChatIdsRef = useRef(new Set<string>())

  function updatePendingNotificationChatIds(updater: (previous: Set<string>) => Set<string>) {
    const next = updater(new Set(pendingNotificationChatIdsRef.current))
    pendingNotificationChatIdsRef.current = next
  }

  function updateObservedRunningPendingChatIds(updater: (previous: Set<string>) => Set<string>) {
    const next = updater(new Set(observedRunningPendingChatIdsRef.current))
    observedRunningPendingChatIdsRef.current = next
  }

  function markChatSeen(chatId: string, lastCompletedTurnAt?: number) {
    if (typeof lastCompletedTurnAt !== "number") return

    const previous = lastSeenMessageAtByChatIdRef.current.get(chatId) ?? 0
    if (lastCompletedTurnAt <= previous) return

    const next = new Map(lastSeenMessageAtByChatIdRef.current)
    next.set(chatId, lastCompletedTurnAt)
    lastSeenMessageAtByChatIdRef.current = next
    writeLastSeenMessageAtByChatId(next)
  }

  function warmProcessedTranscriptCache(chatId: string, snapshot: ChatSnapshot | null) {
    if (!snapshot) return
    const cached = processedTranscriptCacheRef.current.get(chatId)
    if (cached?.source === snapshot.messages) return

    const messages = processTranscriptMessages(snapshot.messages)
    const latestToolIds = getLatestToolIds(messages)
    processedTranscriptCacheRef.current.set(chatId, {
      source: snapshot.messages,
      messages,
      latestToolIds,
    })
  }

  useEffect(() => {
    activeChatIdRef.current = activeChatId
  }, [activeChatId])

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  useEffect(() => {
    return socket.subscribe<SidebarData>({ type: "sidebar" }, (snapshot) => {
      const chatById = new Map(snapshot.projectGroups.flatMap((group) => group.chats.map((chat) => [chat.chatId, chat] as const)))
      const completedChatIds: string[] = []

      updateObservedRunningPendingChatIds((previous) => {
        const next = new Set(previous)
        for (const chat of chatById.values()) {
          if (!pendingNotificationChatIdsRef.current.has(chat.chatId)) continue
          if (chat.status === "starting" || chat.status === "running") {
            next.add(chat.chatId)
          }
        }
        for (const chatId of next) {
          if (!chatById.has(chatId) || !pendingNotificationChatIdsRef.current.has(chatId)) {
            next.delete(chatId)
          }
        }
        return next
      })

      for (const chat of chatById.values()) {
        const previousStatus = previousSidebarStatusesRef.current.get(chat.chatId)
        if ((previousStatus === "starting" || previousStatus === "running") && chat.status === "idle") {
          completedChatIds.push(chat.chatId)
        }
      }

      setUnreadCompletedChatIds((previous) => reconcileUnreadCompletedChatIds({
        previousStatuses: previousSidebarStatusesRef.current,
        projectGroups: snapshot.projectGroups,
        activeChatId: activeChatIdRef.current,
        unreadCompletedChatIds: previous,
        pendingCompletionChatIds: pendingNotificationChatIdsRef.current,
        observedRunningPendingChatIds: observedRunningPendingChatIdsRef.current,
        lastSeenMessageAtByChatId: lastSeenMessageAtByChatIdRef.current,
      }))
      updatePendingNotificationChatIds((previous) => {
        if (previous.size === 0 || completedChatIds.length === 0) return previous
        const next = new Set(previous)
        for (const chatId of completedChatIds) {
          next.delete(chatId)
        }
        return next
      })
      updateObservedRunningPendingChatIds((previous) => {
        if (previous.size === 0 || completedChatIds.length === 0) return previous
        const next = new Set(previous)
        for (const chatId of completedChatIds) {
          next.delete(chatId)
        }
        return next
      })
      previousSidebarStatusesRef.current = getSidebarChatStatusMap(snapshot.projectGroups)
      const activeChat = activeChatIdRef.current ? chatById.get(activeChatIdRef.current) : null
      if (activeChat) {
        markChatSeen(activeChat.chatId, activeChat.lastCompletedTurnAt)
      }
      setSidebarData(snapshot)
      setSidebarReady(true)
      setCommandError(null)

      for (const chatId of completedChatIds) {
        if (!pendingNotificationChatIdsRef.current.has(chatId)) {
          continue
        }
        if (!shouldShowCompletionNotification({
          chatId,
          activeChatId: activeChatIdRef.current,
          documentVisibilityState: document.visibilityState,
        })) {
          continue
        }

        const chat = chatById.get(chatId)
        if (!chat) {
          continue
        }
        void showChatCompletionNotification({
          chatId,
          chatTitle: chat.title,
        })
      }
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<LocalProjectsSnapshot>({ type: "local-projects" }, (snapshot) => {
      setLocalProjects(snapshot)
      setLocalProjectsReady(true)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    return socket.subscribe<UpdateSnapshot>({ type: "update" }, (snapshot) => {
      setUpdateSnapshot(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void socket.command<UpdateSnapshot>({ type: "update.check", force: true }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [connectionStatus, socket])

  useEffect(() => {
    const phase = getUiUpdateRestartPhase()
    const reconnectAction = getUiUpdateRestartReconnectAction(phase, connectionStatus)
    if (reconnectAction === "awaiting_reconnect") {
      setUiUpdateRestartPhase("awaiting_reconnect")
      return
    }

    if (reconnectAction === "navigate_changelog") {
      clearUiUpdateRestartPhase()
      navigate("/settings/changelog", { replace: true })
    }
  }, [connectionStatus, navigate])

  useEffect(() => {
    function handleWindowFocus() {
      if (!updateSnapshot?.lastCheckedAt) return
      if (Date.now() - updateSnapshot.lastCheckedAt <= 60 * 60 * 1000) return
      void socket.command<UpdateSnapshot>({ type: "update.check" }).catch((error) => {
        setCommandError(error instanceof Error ? error.message : String(error))
      })
    }

    window.addEventListener("focus", handleWindowFocus)
    return () => {
      window.removeEventListener("focus", handleWindowFocus)
    }
  }, [socket, updateSnapshot?.lastCheckedAt])

  useEffect(() => {
    return socket.subscribe<KeybindingsSnapshot>({ type: "keybindings" }, (snapshot) => {
      setKeybindings(snapshot)
      setCommandError(null)
    })
  }, [socket])

  useEffect(() => {
    const prewarmChatIds = getRecentSidebarChatIds(sidebarData.projectGroups, 4)
    for (const chatId of prewarmChatIds) {
      if (chatId === activeChatId) continue

      const existingSnapshot = chatSnapshotsById[chatId]
      if (existingSnapshot) {
        warmProcessedTranscriptCache(chatId, existingSnapshot)
        continue
      }
      if (prewarmingChatIdsRef.current.has(chatId)) continue

      prewarmingChatIdsRef.current.add(chatId)
      void socket.command<ChatSnapshot | null>({ type: "chat.prefetch", chatId })
        .then((snapshot) => {
          if (!snapshot) return
          startTransition(() => {
            setChatSnapshotsById((previous) => upsertChatSnapshot(previous, chatId, snapshot))
          })
          warmProcessedTranscriptCache(chatId, snapshot)
        })
        .catch(() => undefined)
        .finally(() => {
          prewarmingChatIdsRef.current.delete(chatId)
        })
    }
  }, [activeChatId, chatSnapshotsById, sidebarData.projectGroups, socket])

  useEffect(() => {
    if (!activeChatId) {
      logKannaState("clearing active chat route")
      setChatReady(true)
      return
    }

    logKannaState("subscribing to chat", { activeChatId })
    setChatReady(Boolean(chatSnapshotsById[activeChatId]))
    return socket.subscribe<ChatSnapshot | null, ChatEvent>(
      { type: "chat", chatId: activeChatId },
      (snapshot) => {
        logKannaState("chat snapshot received", {
          activeChatId,
          snapshotChatId: snapshot?.runtime.chatId ?? null,
          snapshotProvider: snapshot?.runtime.provider ?? null,
          snapshotStatus: snapshot?.runtime.status ?? null,
        })
        warmProcessedTranscriptCache(activeChatId, snapshot)
        startTransition(() => {
          setChatSnapshotsById((previous) => upsertChatSnapshot(previous, activeChatId, snapshot))
          setChatReady(true)
          setCommandError(null)
        })
      },
      (event) => {
        if (event.chatId !== activeChatId) return
        startTransition(() => {
          setChatSnapshotsById((previous) => {
            const next = applyChatEventToCache(previous, activeChatId, event)
            warmProcessedTranscriptCache(activeChatId, next[activeChatId] ?? null)
            return next
          })
          setChatReady(true)
        })
      }
    )
  }, [activeChatId, socket])

  useEffect(() => {
    if (selectedProjectId) return
    const firstGroup = sidebarData.projectGroups[0]
    if (firstGroup) {
      setSelectedProjectId(firstGroup.groupKey)
    }
  }, [selectedProjectId, sidebarData.projectGroups])

  useEffect(() => {
    if (!activeChatId) return
    if (!sidebarReady || !chatReady) return
    const exists = sidebarData.projectGroups.some((group) => group.chats.some((chat) => chat.chatId === activeChatId))
    if (exists) {
      if (pendingChatId === activeChatId) {
        setPendingChatId(null)
      }
      return
    }
    if (pendingChatId === activeChatId) {
      return
    }
    navigate("/")
  }, [activeChatId, chatReady, navigate, pendingChatId, sidebarData.projectGroups, sidebarReady])

  const chatSnapshot = useMemo(
    () => (activeChatId ? chatSnapshotsById[activeChatId] ?? null : null),
    [activeChatId, chatSnapshotsById]
  )

  useEffect(() => {
    if (!chatSnapshot) return
    setSelectedProjectId(chatSnapshot.runtime.projectId)
    if (pendingChatId === chatSnapshot.runtime.chatId) {
      setPendingChatId(null)
    }
  }, [chatSnapshot, pendingChatId])

  useEffect(() => {
    autoFollowTranscriptRef.current = true
    initialScrollCompletedRef.current = false
    if (initialScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(initialScrollFrameRef.current)
      initialScrollFrameRef.current = null
    }
    if (initialScrollTimeoutRef.current !== null) {
      window.clearTimeout(initialScrollTimeoutRef.current)
      initialScrollTimeoutRef.current = null
    }
    setIsAtBottom(true)
    if (!activeChatId) return
    const activeChat = sidebarData.projectGroups.flatMap((group) => group.chats).find((chat) => chat.chatId === activeChatId)
    if (activeChat) {
      markChatSeen(activeChat.chatId, activeChat.lastCompletedTurnAt)
    }
    setUnreadCompletedChatIds((previous) => {
      if (!previous.has(activeChatId)) return previous
      const next = new Set(previous)
      next.delete(activeChatId)
      return next
    })
    updatePendingNotificationChatIds((previous) => {
      if (!previous.has(activeChatId)) return previous
      const next = new Set(previous)
      next.delete(activeChatId)
      return next
    })
    updateObservedRunningPendingChatIds((previous) => {
      if (!previous.has(activeChatId)) return previous
      const next = new Set(previous)
      next.delete(activeChatId)
      return next
    })
  }, [activeChatId, sidebarData.projectGroups])

  useEffect(() => {
    return () => {
      if (initialScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(initialScrollFrameRef.current)
      }
      if (initialScrollTimeoutRef.current !== null) {
        window.clearTimeout(initialScrollTimeoutRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      setInputHeight(element.getBoundingClientRect().height)
    })
    observer.observe(element)
    setInputHeight(element.getBoundingClientRect().height)
    return () => observer.disconnect()
  }, [])

  const activeChatSnapshot = useMemo(
    () => getActiveChatSnapshot(chatSnapshot, activeChatId),
    [activeChatId, chatSnapshot]
  )
  useEffect(() => {
    logKannaState("active snapshot resolved", {
      routeChatId: activeChatId,
      rawSnapshotChatId: chatSnapshot?.runtime.chatId ?? null,
      rawSnapshotProvider: chatSnapshot?.runtime.provider ?? null,
      activeSnapshotChatId: activeChatSnapshot?.runtime.chatId ?? null,
      activeSnapshotProvider: activeChatSnapshot?.runtime.provider ?? null,
      pendingChatId,
    })
  }, [activeChatId, activeChatSnapshot, chatSnapshot, pendingChatId])
  const processedTranscript = useMemo(() => {
    if (!activeChatSnapshot || !activeChatId) {
      return {
        messages: [] as ReturnType<typeof processTranscriptMessages>,
        latestToolIds: getLatestToolIds([]),
      }
    }

    const cached = processedTranscriptCacheRef.current.get(activeChatId)
    if (cached?.source === activeChatSnapshot.messages) {
      return cached
    }

    const messages = processTranscriptMessages(activeChatSnapshot.messages)
    const latestToolIds = getLatestToolIds(messages)
    const next = {
      source: activeChatSnapshot.messages,
      messages,
      latestToolIds,
    }
    processedTranscriptCacheRef.current.set(activeChatId, next)
    return next
  }, [activeChatId, activeChatSnapshot])
  const messages = processedTranscript.messages
  const latestToolIds = processedTranscript.latestToolIds
  const runtime = activeChatSnapshot?.runtime ?? null
  const hasOlderMessages = activeChatSnapshot?.hasOlderMessages ?? false
  const availableProviders = activeChatSnapshot?.availableProviders ?? PROVIDERS
  const isProcessing = isProcessingStatus(runtime?.status)
  const canCancel = canCancelStatus(runtime?.status)
  const transcriptPaddingBottom = Math.max(MIN_TRANSCRIPT_PADDING_BOTTOM, inputHeight + 24)
  const showScrollButton = !isAtBottom && messages.length > 0
  const fallbackLocalProjectPath = localProjects?.projects[0]?.localPath ?? null
  const navbarLocalPath =
    runtime?.localPath
    ?? fallbackLocalProjectPath
    ?? sidebarData.projectGroups[0]?.localPath
  const hasSelectedProject = Boolean(
    selectedProjectId
    ?? runtime?.projectId
    ?? sidebarData.projectGroups[0]?.groupKey
    ?? fallbackLocalProjectPath
  )

  useLayoutEffect(() => {
    if (initialScrollCompletedRef.current) return

    const element = scrollRef.current
    if (!element) return
    if (activeChatId && !runtime) return

    const scrollToLatestMessage = () => {
      const currentElement = scrollRef.current
      if (!currentElement) return
      currentElement.scrollTo({ top: currentElement.scrollHeight, behavior: "auto" })
    }

    scrollToLatestMessage()
    if (initialScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(initialScrollFrameRef.current)
    }
    initialScrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollToLatestMessage()
      initialScrollFrameRef.current = null
    })
    if (initialScrollTimeoutRef.current !== null) {
      window.clearTimeout(initialScrollTimeoutRef.current)
    }
    initialScrollTimeoutRef.current = window.setTimeout(() => {
      scrollToLatestMessage()
      initialScrollTimeoutRef.current = null
    }, 60)
    initialScrollCompletedRef.current = true
  }, [activeChatId, inputHeight, messages.length, runtime])

  useEffect(() => {
    if (!initialScrollCompletedRef.current || !autoFollowTranscriptRef.current) return

    const frameId = window.requestAnimationFrame(() => {
      const element = scrollRef.current
      if (!element || !autoFollowTranscriptRef.current) return
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [activeChatId, inputHeight, messages.length, runtime?.status])

  function updateScrollState() {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const nextIsAtBottom = shouldAutoFollowTranscript(distance)
    autoFollowTranscriptRef.current = nextIsAtBottom
    setIsAtBottom(nextIsAtBottom)
    if (initialScrollCompletedRef.current && !loadingOlderMessages && hasOlderMessages && element.scrollTop <= 160) {
      void handleLoadOlderMessages()
    }
  }

  function scrollToBottom() {
    const element = scrollRef.current
    if (!element) return
    autoFollowTranscriptRef.current = true
    setIsAtBottom(true)
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }

  async function handleLoadOlderMessages() {
    if (!activeChatId || loadingOlderMessages) return
    const snapshot = chatSnapshotsById[activeChatId]
    if (!snapshot?.hasOlderMessages) return

    const beforeMessageId = snapshot.oldestLoadedMessageId ?? snapshot.messages[0]?._id
    if (!beforeMessageId) return

    const element = scrollRef.current
    pendingPrependScrollHeightRef.current = element?.scrollHeight ?? null
    setLoadingOlderMessages(true)
    try {
      const olderSnapshot = await socket.command<ChatSnapshot | null>({
        type: "chat.loadMore",
        chatId: activeChatId,
        beforeMessageId,
        limit: 200,
      })
      startTransition(() => {
        setChatSnapshotsById((previous) => prependChatSnapshotChunk(previous, activeChatId, olderSnapshot))
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      pendingPrependScrollHeightRef.current = null
    } finally {
      setLoadingOlderMessages(false)
    }
  }

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      updateScrollState()
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [inputHeight, messages.length, runtime?.status])

  useLayoutEffect(() => {
    const previousHeight = pendingPrependScrollHeightRef.current
    if (previousHeight === null) return

    const element = scrollRef.current
    if (!element) return

    const nextHeight = element.scrollHeight
    element.scrollTop += nextHeight - previousHeight
    pendingPrependScrollHeightRef.current = null
  }, [messages.length])

  async function createChatForProject(projectId: string) {
    useChatPreferencesStore.getState().initializeComposerForNewChat()
    const result = await socket.command<{ chatId: string }>({ type: "chat.create", projectId })
    setSelectedProjectId(projectId)
    setPendingChatId(result.chatId)
    navigate(`/chat/${result.chatId}`)
    setSidebarOpen(false)
    setCommandError(null)
  }

  async function resolveProjectIdForStartChat(intent: StartChatIntent): Promise<{ projectId: string; localPath?: string }> {
    if (intent.kind === "project_id") {
      return { projectId: intent.projectId }
    }

    if (intent.kind === "local_path") {
      const result = await socket.command<{ projectId: string }>({ type: "project.open", localPath: intent.localPath })
      return { projectId: result.projectId, localPath: intent.localPath }
    }

    const result = await socket.command<{ projectId: string }>(
      intent.project.mode === "new"
        ? { type: "project.create", localPath: intent.project.localPath, title: intent.project.title }
        : { type: "project.open", localPath: intent.project.localPath }
    )
    return { projectId: result.projectId, localPath: intent.project.localPath }
  }

  async function startChatFromIntent(intent: StartChatIntent) {
    try {
      const localPath = intent.kind === "project_id"
        ? null
        : intent.kind === "local_path"
          ? intent.localPath
          : intent.project.localPath
      if (localPath) {
        setStartingLocalPath(localPath)
      }

      const { projectId } = await resolveProjectIdForStartChat(intent)
      await createChatForProject(projectId)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingLocalPath(null)
    }
  }

  async function handleCreateChat(projectId: string) {
    await startChatFromIntent({ kind: "project_id", projectId })
  }

  async function handleOpenLocalProject(localPath: string) {
    await startChatFromIntent({ kind: "local_path", localPath })
  }

  async function handleCreateProject(project: ProjectRequest) {
    await startChatFromIntent({ kind: "project_request", project })
  }

  async function handleCheckForUpdates(options?: { force?: boolean }) {
    try {
      await socket.command<UpdateSnapshot>({ type: "update.check", force: options?.force })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleInstallUpdate() {
    try {
      const result = await socket.command<UpdateInstallResult>({ type: "update.install" })
      if (!result.ok) {
        clearUiUpdateRestartPhase()
        setCommandError(null)
        await dialog.alert({
          title: result.userTitle ?? "Update failed",
          description: result.userMessage ?? "Kanna could not install the update. Try again later.",
          closeLabel: "OK",
        })
        return
      }

      if (result.ok && result.action === "reload") {
        window.location.reload()
        return
      }

      if (result.ok && result.action === "restart") {
        setUiUpdateRestartPhase("awaiting_disconnect")
      }
      setCommandError(null)
    } catch (error) {
      clearUiUpdateRestartPhase()
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleSend(
    content: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }
  ) {
    try {
      requestNotificationPermissionOnUserAction()

      let projectId = selectedProjectId ?? sidebarData.projectGroups[0]?.groupKey ?? null
      if (!activeChatId && !projectId && fallbackLocalProjectPath) {
        const project = await socket.command<{ projectId: string }>({
          type: "project.open",
          localPath: fallbackLocalProjectPath,
        })
        projectId = project.projectId
        setSelectedProjectId(projectId)
      }

      if (!activeChatId && !projectId) {
        throw new Error("Open a project first")
      }

      const result = await socket.command<{ chatId?: string }>({
        type: "chat.send",
        chatId: activeChatId ?? undefined,
        projectId: activeChatId ? undefined : projectId ?? undefined,
        provider: options?.provider,
        content,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
      })

      if (!activeChatId && result.chatId) {
        setPendingChatId(result.chatId)
        updatePendingNotificationChatIds((previous) => {
          const next = new Set(previous)
          next.add(result.chatId!)
          return next
        })
        navigate(`/chat/${result.chatId}`)
      } else if (activeChatId) {
        updatePendingNotificationChatIds((previous) => {
          const next = new Set(previous)
          next.add(activeChatId)
          return next
        })
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async function handleCancel() {
    if (!activeChatId) return
    try {
      await socket.command({ type: "chat.cancel", chatId: activeChatId })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDeleteChat(chat: SidebarChatRow) {
    const confirmed = await dialog.confirm({
      title: "Delete Chat",
      description: `Delete "${chat.title}"? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      await socket.command({ type: "chat.delete", chatId: chat.chatId })
      if (chat.chatId === activeChatId) {
        const nextChatId = getNewestRemainingChatId(sidebarData.projectGroups, chat.chatId)
        navigate(nextChatId ? `/chat/${nextChatId}` : "/")
      }
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleRemoveProject(projectId: string) {
    const project = sidebarData.projectGroups.find((group) => group.groupKey === projectId)
    if (!project) return
    const projectName = project.localPath.split("/").filter(Boolean).pop() ?? project.localPath
    const confirmed = await dialog.confirm({
      title: "Remove",
      description: `Remove "${projectName}" from the sidebar? Existing chats will be removed from ${APP_NAME}.`,
      confirmLabel: "Remove",
      confirmVariant: "destructive",
    })
    if (!confirmed) return

    try {
      await socket.command({ type: "project.remove", projectId })
      useTerminalLayoutStore.getState().clearProject(projectId)
      useRightSidebarStore.getState().clearProject(projectId)
      if (runtime?.projectId === projectId) {
        navigate("/")
      }
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleOpenExternal(action: "open_finder" | "open_terminal" | "open_editor") {
    const localPath = runtime?.localPath ?? localProjects?.projects[0]?.localPath ?? sidebarData.projectGroups[0]?.localPath
    if (!localPath) return
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleOpenLocalLink(target: { path: string; line?: number; column?: number }) {
    try {
      await openExternal({
        action: "open_editor",
        localPath: target.path,
        line: target.line,
        column: target.column,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleOpenExternalPath(action: "open_finder" | "open_editor", localPath: string) {
    try {
      await openExternal({
        action,
        localPath,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function openExternal(command: {
    action: "open_finder" | "open_terminal" | "open_editor"
    localPath: string
    line?: number
    column?: number
  }) {
    const preferences = useTerminalPreferencesStore.getState()
    setCommandError(null)
    await socket.command({
      type: "system.openExternal",
      ...command,
      editor: command.action === "open_editor"
        ? {
            preset: preferences.editorPreset,
            commandTemplate: preferences.editorCommandTemplate,
          }
        : undefined,
    })
  }

  function handleCompose() {
    const intent = resolveComposeIntent({
      selectedProjectId,
      sidebarProjectId: sidebarData.projectGroups[0]?.groupKey,
      fallbackLocalProjectPath,
    })
    if (intent) {
      void startChatFromIntent(intent)
      return
    }

    navigate("/")
  }

  async function handleAskUserQuestion(
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) {
    if (!activeChatId) return
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: { questions, answers },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleExitPlanMode(toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) {
    if (!activeChatId) return
    if (confirmed) {
      useChatPreferencesStore.getState().setComposerPlanMode(false)
    }
    try {
      await socket.command({
        type: "chat.respondTool",
        chatId: activeChatId,
        toolUseId,
        result: {
          confirmed,
          ...(clearContext ? { clearContext: true } : {}),
          ...(message ? { message } : {}),
        },
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    socket,
    activeChatId,
    sidebarData,
    localProjects,
    updateSnapshot,
    chatSnapshot,
    keybindings,
    connectionStatus,
    sidebarReady,
    localProjectsReady,
    commandError,
    startingLocalPath,
    sidebarOpen,
    sidebarCollapsed,
    scrollRef,
    inputRef,
    messages,
    latestToolIds,
    runtime,
    availableProviders,
    unreadCompletedChatIds,
    isProcessing,
    canCancel,
    hasOlderMessages,
    loadingOlderMessages,
    transcriptPaddingBottom,
    showScrollButton,
    navbarLocalPath,
    editorLabel,
    hasSelectedProject,
    openSidebar: () => setSidebarOpen(true),
    closeSidebar: () => setSidebarOpen(false),
    collapseSidebar: () => setSidebarCollapsed(true),
    expandSidebar: () => setSidebarCollapsed(false),
    updateScrollState,
    scrollToBottom,
    handleCreateChat,
    handleOpenLocalProject,
    handleCreateProject,
    handleCheckForUpdates,
    handleInstallUpdate,
    handleSend,
    handleCancel,
    handleLoadOlderMessages,
    handleDeleteChat,
    handleRemoveProject,
    handleOpenExternal,
    handleOpenExternalPath,
    handleOpenLocalLink,
    handleCompose,
    handleAskUserQuestion,
    handleExitPlanMode,
  }
}
