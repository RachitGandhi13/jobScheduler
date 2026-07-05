import { useEffect, useState } from "react";
import { projectsApi } from "../api/client";
import type { AuthSession } from "../auth";
import type { Project } from "../types";
import { GlassCard } from "./GlassCard";
import { CloseIcon } from "./icons";
import { Skeleton } from "./Skeleton";

interface AccountPanelProps {
  session: AuthSession;
  onLogout: () => void;
  onClose: () => void;
  onSwitchProject: (project: { id: string; name: string }) => void;
}

const CAN_MANAGE: Record<AuthSession["role"], boolean> = { owner: true, admin: true, member: false };

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  const derived = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return derived || source.slice(0, 1).toUpperCase();
}

export function AccountPanel({ session, onLogout, onClose, onSwitchProject }: AccountPanelProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManage = CAN_MANAGE[session.role];

  function refresh() {
    projectsApi
      .list()
      .then((res) => setProjects(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(refresh, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await projectsApi.create(newName.trim());
      setNewName("");
      refresh();
      onSwitchProject({ id: res.data.id, name: res.data.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(projectId: string) {
    if (!renameValue.trim()) return;
    setBusyId(projectId);
    try {
      const res = await projectsApi.rename(projectId, renameValue.trim());
      setRenamingId(null);
      refresh();
      if (session.project?.id === projectId) {
        onSwitchProject({ id: res.data.id, name: res.data.name });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(project: Project) {
    if (!confirm(`Delete "${project.name}"? This deletes every queue and job in it.`)) return;
    setBusyId(project.id);
    try {
      await projectsApi.remove(project.id);
      const remaining = (projects ?? []).filter((p) => p.id !== project.id);
      refresh();
      if (session.project?.id === project.id && remaining[0]) {
        onSwitchProject({ id: remaining[0].id, name: remaining[0].name });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-espresso/25 p-4 backdrop-blur-sm">
      <GlassCard className="animate-scale-in w-full max-w-md p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Account</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-olive-dark/50 transition hover:bg-olive-dark/[0.06] hover:text-olive-dark"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Identity */}
        <div className="mb-5 flex items-center gap-3.5 rounded-xl border border-olive-dark/[0.06] bg-white/60 p-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-olive text-sm font-semibold text-white">
            {initials(session.user.name, session.user.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-olive-dark">
              {session.user.name ?? session.user.email.split("@")[0]}
            </p>
            <p className="truncate text-xs text-olive-dark/50">{session.user.email}</p>
            <p className="mt-0.5 truncate text-xs text-olive-dark/50">{session.organization.name}</p>
          </div>
          <span className="shrink-0 rounded-full bg-sage/25 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-olive-dark/70 uppercase">
            {session.role}
          </span>
        </div>

        <div className="mb-5">
          <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-olive-dark/45 uppercase">Projects</h3>
          {error && (
            <p className="animate-fade-in mb-2 rounded-lg border border-terracotta/25 bg-terracotta-light/40 px-2.5 py-1.5 text-xs text-olive-dark">
              {error}
            </p>
          )}

          {!projects && (
            <div className="mb-3 space-y-1.5">
              <Skeleton className="h-10 rounded-xl" />
              <Skeleton className="h-10 rounded-xl" />
            </div>
          )}

          {projects && (
            <ul className="mb-3 max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
              {projects.map((project) => {
                const active = project.id === session.project?.id;
                return (
                  <li
                    key={project.id}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${
                      active
                        ? "border-sage/50 bg-sage/20"
                        : "border-olive-dark/[0.06] bg-white/50 hover:border-olive-dark/15 hover:bg-white"
                    }`}
                  >
                    {renamingId === project.id ? (
                      <>
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="input input-sm min-w-0 flex-1"
                        />
                        <button
                          onClick={() => handleRename(project.id)}
                          disabled={busyId === project.id}
                          className="shrink-0 text-xs font-semibold text-olive transition hover:text-olive-dark disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setRenamingId(null)}
                          className="shrink-0 text-xs text-olive-dark/50 transition hover:text-olive-dark"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => onSwitchProject({ id: project.id, name: project.name })}
                          className="min-w-0 flex-1 truncate text-left font-medium text-olive-dark"
                          title={project.name}
                        >
                          {project.name}
                          {active && (
                            <span className="ml-2 rounded-full bg-sage/40 px-1.5 py-0.5 text-[10px] font-semibold text-olive-dark/70">
                              active
                            </span>
                          )}
                        </button>
                        {canManage && (
                          <>
                            <button
                              onClick={() => {
                                setRenamingId(project.id);
                                setRenameValue(project.name);
                              }}
                              className="shrink-0 text-xs text-olive-dark/45 transition hover:text-olive-dark"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => handleDelete(project)}
                              disabled={busyId === project.id}
                              className="shrink-0 text-xs text-terracotta/80 transition hover:text-terracotta disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {canManage && (
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New project name"
                className="input input-sm min-w-0 flex-1"
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="btn btn-primary btn-press shrink-0 px-3.5 py-1.5 text-xs"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          {!canManage && (
            <p className="text-xs text-olive-dark/50">Only owners and admins can create, rename, or delete projects.</p>
          )}
        </div>

        <button onClick={onLogout} className="btn btn-danger btn-press w-full py-2.5 text-sm">
          Log out
        </button>
      </GlassCard>
    </div>
  );
}
