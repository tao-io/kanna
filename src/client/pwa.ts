export function shouldAutoScrollChatToBottom(search: string) {
  const params = new URLSearchParams(search)
  return params.get("autoscroll") === "1"
}

export function requestNotificationPermissionOnUserAction() {
  if (typeof window === "undefined" || typeof Notification === "undefined") return
  if (Notification.permission !== "default") return
  void Notification.requestPermission().catch(() => undefined)
}

export function shouldShowCompletionNotification(params: {
  chatId: string
  activeChatId: string | null
  documentVisibilityState: DocumentVisibilityState
}) {
  if (typeof Notification === "undefined") return false
  if (Notification.permission !== "granted") return false
  if (params.documentVisibilityState === "visible" && params.activeChatId === params.chatId) return false
  return true
}

export async function showChatCompletionNotification(params: {
  chatId: string
  chatTitle: string
}) {
  if (typeof ServiceWorkerRegistration === "undefined") return
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) return

  await registration.showNotification(`Kanna: ${params.chatTitle}`, {
    body: "Chat completed",
    tag: `chat-complete:${params.chatId}`,
    data: {
      url: `/chat/${params.chatId}?autoscroll=1`,
    },
  })
}
