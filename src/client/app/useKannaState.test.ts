import { describe, expect, test } from "bun:test"
import {
  getActiveChatSnapshot,
  getNewestRemainingChatId,
  getUiUpdateRestartReconnectAction,
  reconcileUnreadCompletedChatIds,
  resolveComposeIntent,
  shouldAutoFollowTranscript,
  shouldPinTranscriptToBottom,
} from "./useKannaState"
import type { ChatSnapshot, SidebarChatRow, SidebarData } from "../../shared/types"

function createSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [
          {
            _id: "row-1",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Newest",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 3,
            hasAutomation: false,
          },
          {
            _id: "row-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Older",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 2,
            hasAutomation: false,
          },
          {
            _id: "row-3",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Oldest",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
      },
      {
        groupKey: "project-2",
        localPath: "/tmp/project-2",
        chats: [
          {
            _id: "row-4",
            _creationTime: 1,
            chatId: "chat-4",
            title: "Other project",
            status: "idle",
            localPath: "/tmp/project-2",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
      },
    ],
  }
}

describe("getNewestRemainingChatId", () => {
  test("returns the next newest chat from the same project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-3")).toBe("chat-2")
  })

  test("returns null when no other chats remain in the project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBeNull()
  })

  test("returns null when the chat is not found", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "missing")).toBeNull()
  })
})

describe("shouldPinTranscriptToBottom", () => {
  test("returns true when the transcript is at the bottom", () => {
    expect(shouldPinTranscriptToBottom(0)).toBe(true)
  })

  test("returns true when the transcript is near the bottom", () => {
    expect(shouldPinTranscriptToBottom(119)).toBe(true)
  })

  test("returns false when the transcript is not near the bottom", () => {
    expect(shouldPinTranscriptToBottom(120)).toBe(false)
  })
})

describe("getUiUpdateRestartReconnectAction", () => {
  test("waits for reconnect after the socket disconnects", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "disconnected")).toBe("awaiting_reconnect")
  })

  test("navigates to changelog after reconnect", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_reconnect", "connected")).toBe("navigate_changelog")
  })

  test("does nothing for unrelated phase and connection combinations", () => {
    expect(getUiUpdateRestartReconnectAction(null, "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_reconnect", "disconnected")).toBe("none")
  })
})

describe("resolveComposeIntent", () => {
  test("prefers the selected project when available", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: "project-selected",
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-selected" })
  })

  test("falls back to the first sidebar project", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-sidebar" })
  })

  test("uses the first local project path when no project is selected", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "local_path", localPath: "/tmp/project" })
  })

  test("returns null when no project target exists", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: null,
      })
    ).toBeNull()
  })
})

describe("getActiveChatSnapshot", () => {
  test("returns the snapshot when it matches the active chat id", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "idle",
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      messages: [],
      hasOlderMessages: false,
      oldestLoadedMessageId: null,
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-1")).toEqual(snapshot)
  })

  test("returns null for a stale snapshot from a previous route", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-old",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Old chat",
        status: "idle",
        provider: "claude",
        planMode: false,
        sessionToken: null,
      },
      messages: [],
      hasOlderMessages: false,
      oldestLoadedMessageId: null,
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-new")).toBeNull()
  })
})

describe("shouldAutoFollowTranscript", () => {
  test("returns true when the transcript is still pinned to the bottom", () => {
    expect(shouldAutoFollowTranscript(0)).toBe(true)
  })

  test("returns true when the transcript is only slightly above the bottom", () => {
    expect(shouldAutoFollowTranscript(23)).toBe(true)
  })

  test("returns false when the reader has scrolled away from the bottom", () => {
    expect(shouldAutoFollowTranscript(24)).toBe(false)
  })
})

describe("reconcileUnreadCompletedChatIds", () => {
  function createChat(chatId: string, status: SidebarChatRow["status"]): SidebarChatRow {
    return {
      _id: `row-${chatId}`,
      _creationTime: 1,
      chatId,
      title: chatId,
      status,
      localPath: "/tmp/project-1",
      provider: null,
      lastMessageAt: 1,
      hasAutomation: false,
    }
  }

  test("marks background chats when they finish running", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "running"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [createChat("chat-1", "idle")],
      }],
      activeChatId: "chat-2",
      unreadCompletedChatIds: new Set(),
    })

    expect([...next]).toEqual(["chat-1"])
  })

  test("marks background chats when a pending sent turn has completed", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "idle"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [createChat("chat-1", "idle")],
      }],
      activeChatId: "chat-2",
      unreadCompletedChatIds: new Set(),
      pendingCompletionChatIds: new Set(["chat-1"]),
      observedRunningPendingChatIds: new Set(["chat-1"]),
    })

    expect([...next]).toEqual(["chat-1"])
  })

  test("does not mark a pending chat until it has been seen running", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "idle"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [createChat("chat-1", "idle")],
      }],
      activeChatId: "chat-2",
      unreadCompletedChatIds: new Set(),
      pendingCompletionChatIds: new Set(["chat-1"]),
      observedRunningPendingChatIds: new Set(),
      lastSeenMessageAtByChatId: new Map([["chat-1", 1]]),
    })

    expect(next.size).toBe(0)
  })

  test("marks chats with unseen newer messages after reopening the app", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "idle"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [{
          ...createChat("chat-1", "idle"),
          lastCompletedTurnAt: 10,
        }],
      }],
      activeChatId: "chat-2",
      unreadCompletedChatIds: new Set(),
      lastSeenMessageAtByChatId: new Map([["chat-1", 5]]),
    })

    expect([...next]).toEqual(["chat-1"])
  })

  test("does not mark the active chat when it finishes", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "running"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [createChat("chat-1", "idle")],
      }],
      activeChatId: "chat-1",
      unreadCompletedChatIds: new Set(),
    })

    expect(next.size).toBe(0)
  })

  test("clears markers for the chat that becomes active", () => {
    const next = reconcileUnreadCompletedChatIds({
      previousStatuses: new Map<string, SidebarChatRow["status"]>([["chat-1", "idle"]]),
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [createChat("chat-1", "idle")],
      }],
      activeChatId: "chat-1",
      unreadCompletedChatIds: new Set(["chat-1"]),
    })

    expect(next.size).toBe(0)
  })
})
