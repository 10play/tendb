import { AppShell } from "./components/AppShell";
import { EngineDown } from "./components/EngineDown";
import { AlertsScreen } from "./screens/Alerts";
import { DashboardScreen } from "./screens/Dashboard";
import { BranchesScreen } from "./screens/Branches";
import { TablesScreen } from "./screens/Tables";
import { SqlEditorScreen } from "./screens/SqlEditor";
import { PerformanceScreen } from "./screens/Performance";
import { SnapshotsScreen } from "./screens/Snapshots";
import { useHashRoute } from "./lib/hooks";
import { useAppContext, useEngineStatus } from "./lib/queries";

export function App() {
  const [screen, navigate] = useHashRoute();
  const context = useAppContext();
  const status = useEngineStatus();

  // Only take over the view when there is nothing to show. Once a status has
  // landed, a failing poll degrades to a header chip instead of wiping the page.
  const unreachable = status.isError && !status.data;

  return (
    <AppShell
      context={context.data}
      status={status.data}
      screen={screen}
      onNavigate={navigate}
      degraded={status.isError && Boolean(status.data)}
    >
      {unreachable ? (
        <EngineDown
          error={status.error}
          onRetry={() => void status.refetch()}
          retrying={status.isFetching}
        />
      ) : screen === "dashboard" ? (
        <DashboardScreen onNavigate={navigate} />
      ) : screen === "alerts" ? (
        <AlertsScreen />
      ) : screen === "branches" ? (
        <BranchesScreen />
      ) : screen === "tables" ? (
        <TablesScreen onNavigate={navigate} />
      ) : screen === "sql" ? (
        <SqlEditorScreen onNavigate={navigate} />
      ) : screen === "perf" ? (
        <PerformanceScreen onNavigate={navigate} />
      ) : (
        <SnapshotsScreen />
      )}
    </AppShell>
  );
}
