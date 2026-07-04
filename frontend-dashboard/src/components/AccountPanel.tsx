import { useEffect, useState } from "react";
import { projectsApi } from "../api/client";
import type { AuthSession } from "../auth";
import type { Project } from "../types";
import { GlassCard } from "./GlassCard";
import { CloseIcon } from "./icons";

interface AccountPanelProps {
  session: AuthSession;
  onLogout: () => void;
  onClose: () => void;
  onSwitchProject: (project: { id: string; name: string }) => void;
}

const CAN_MANAGE: Record<AuthSession["role"], boolean> = { owner: true, admin: true, member: false };

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-olive-dark/20 p-4 backdrop-blur-sm">
      <GlassCard className="w-full max-w-md p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Account</h2>
          <button onClick={onClose} className="text-olive-dark/60 hover:text-olive-dark" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <dl className="mb-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Email</dt>
            <dd className="font-medium text-olive-dark">{session.user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Organization</dt>
            <dd className="font-medium text-olive-dark">{session.organization.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Role</dt>
            <dd className="font-medium capitalize text-olive-dark">{session.role}</dd>
          </div>
        </dl>

        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold text-olive-dark">Projects</h3>
          {error && <p className="mb-2 text-xs text-terracotta">{error}</p>}

          {!projects && <p className="text-xs text-olive-dark/50">Loading…</p>}

          {projects && (
            <ul className="mb-3 max-h-48 space-y-1.5 overflow-y-auto">
              {projects.map((project) => {
                const active = project.id === session.project?.id;
                return (
                  <li
                    key={project.id}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                      active ? "bg-sage/40" : "bg-white/40"
                    }`}
                  >
                    {renamingId === project.id ? (
                      <>
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="min-w-0 flex-1 rounded border border-olive-dark/20 bg-white/80 px-1.5 py-0.5 text-xs"
                        />
                        <button
                          onClick={() => handleRename(project.id)}
                          disabled={busyId === project.id}
                          className="shrink-0 text-xs font-medium text-olive hover:text-olive-dark"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setRenamingId(null)}
                          className="shrink-0 text-xs text-olive-dark/50 hover:text-olive-dark"
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
                          {active && <span className="ml-1.5 text-xs font-normal text-olive-dark/50">active</span>}
                        </button>
                        {canManage && (
                          <>
                            <button
                              onClick={() => {
                                setRenamingId(project.id);
                                setRenameValue(project.name);
                              }}
                              className="shrink-0 text-xs text-olive-dark/50 hover:text-olive-dark"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => handleDelete(project)}
                              disabled={busyId === project.id}
                              className="shrink-0 text-xs text-terracotta hover:text-terracotta-light"
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
                className="min-w-0 flex-1 rounded-lg border border-olive-dark/20 bg-white/80 px-2.5 py-1.5 text-xs"
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="shrink-0 rounded-lg bg-olive px-3 py-1.5 text-xs font-medium text-white transition hover:bg-olive-dark disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          {!canManage && (
            <p className="text-xs text-olive-dark/50">Only owners and admins can create, rename, or delete projects.</p>
          )}
        </div>

        <button
          onClick={onLogout}
          className="w-full rounded-lg bg-terracotta px-4 py-2 text-sm font-medium text-white transition hover:bg-terracotta-light hover:text-olive-dark"
        >
          Log out
        </button>
      </GlassCard>
    </div>
  );
}
