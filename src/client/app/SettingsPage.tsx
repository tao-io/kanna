import { Info, Loader2, Settings } from "lucide-react"
import { useOutletContext } from "react-router-dom"
import { SDK_CLIENT_APP } from "../../shared/branding"
import { PageHeader } from "./PageHeader"
import type { KannaState } from "./useKannaState"

function SettingsCard({
  title,
  description,
  value,
}: {
  title: string
  description: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-1 text-sm font-medium text-foreground">{title}</div>
      <div className="mb-3 text-sm text-muted-foreground">{description}</div>
      <div className="rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
        {value}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const state = useOutletContext<KannaState>()
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? "Settings"

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-background">
      <PageHeader
        icon={Settings}
        title={machineName}
        subtitle={isConnecting
          ? "Kanna is starting up and loading your local environment settings."
          : "Kanna is connected. Configure app details and review your local environment."}
      />

      <div className="w-full px-6 pb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">Settings</h2>
        </div>

        {isConnecting ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading machine settings…</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SettingsCard
              title="Machine"
              description="The local machine currently connected to Kanna."
              value={state.localProjects?.machine.displayName ?? "Unavailable"}
            />
            <SettingsCard
              title="Connection"
              description="Current connection state for the local Kanna runtime."
              value={state.connectionStatus}
            />
            <SettingsCard
              title="Projects Indexed"
              description="Number of local projects currently available in the app."
              value={String(state.localProjects?.projects.length ?? 0)}
            />
            <SettingsCard
              title="App Version"
              description="Current Kanna desktop client build."
              value={SDK_CLIENT_APP.split("/")[1] ?? "unknown"}
            />
          </div>
        )}

        {state.commandError ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{state.commandError}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
