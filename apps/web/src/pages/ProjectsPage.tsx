import { type FormEvent, useMemo, useState } from 'react';
import type { RunStatus } from '@cqa/shared';
import { ApiError, api, type ProjectListItem } from '../api';
import { CopyButton, Empty, ErrorBox, Link, Loading, PageHeader, StatusBadge, formatDate, hostPath, useLoader } from '../components/ui';

type StatusFilter = 'all' | 'active' | 'scanned' | 'unscanned';
type SortOption = 'recent' | 'name' | 'scans';

export function ProjectsPage() {
  const { data, error, reload } = useLoader(() => api.listProjects(), [], (list) => list.some((p) => p.lastRun?.status === 'running' || p.lastRun?.status === 'queued'));
  const [showForm, setShowForm] = useState(false);
  const [showQuickScan, setShowQuickScan] = useState(false);
  const [showHero, setShowHero] = useState(() => {
    try {
      return localStorage.getItem('cqa_hide_hero') !== 'true';
    } catch {
      return true;
    }
  });
  const [editingProject, setEditingProject] = useState<ProjectListItem | null>(null);
  const [duplicatingProject, setDuplicatingProject] = useState<ProjectListItem | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectListItem | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('recent');

  const projects = data ?? [];

  const toggleHero = () => {
    setShowHero((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('cqa_hide_hero', next ? 'false' : 'true');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4500);
  };

  // Metrics computation for dashboard
  const metrics = useMemo(() => {
    const totalProjects = projects.length;
    const totalScans = projects.reduce((acc, p) => acc + (p.runCount || 0), 0);
    const activeScans = projects.filter((p) => p.lastRun?.status === 'running' || p.lastRun?.status === 'queued').length;
    const completedScans = projects.filter((p) => p.lastRun?.status === 'completed').length;
    const partialOrGaps = projects.filter((p) => p.lastRun?.status === 'partial' || p.lastRun?.status === 'failed').length;
    const withUrls = projects.filter((p) => Boolean(p.courseUrl)).length;
    return { totalProjects, totalScans, activeScans, completedScans, partialOrGaps, withUrls };
  }, [projects]);

  // Filtering and sorting
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (q && !`${p.name} ${p.description ?? ''} ${p.courseUrl ?? ''}`.toLowerCase().includes(q)) return false;
        if (statusFilter === 'active') return p.lastRun?.status === 'running' || p.lastRun?.status === 'queued';
        if (statusFilter === 'scanned') return (p.runCount || 0) > 0;
        if (statusFilter === 'unscanned') return (p.runCount || 0) === 0;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'scans') return (b.runCount || 0) - (a.runCount || 0);
        // default recent
        const aTime = a.lastRun?.queuedAt ? Date.parse(a.lastRun.queuedAt) : 0;
        const bTime = b.lastRun?.queuedAt ? Date.parse(b.lastRun.queuedAt) : 0;
        return bTime - aTime;
      });
  }, [projects, search, statusFilter, sortBy]);

  // Recent active/completed scans
  const recentScans = useMemo(() => {
    return projects
      .filter((p) => p.lastRun)
      .sort((a, b) => Date.parse(b.lastRun!.queuedAt) - Date.parse(a.lastRun!.queuedAt))
      .slice(0, 5);
  }, [projects]);

  return (
    <section aria-labelledby="dashboard-heading" className="dashboard-view">
      {/* Landing Hero Section */}
      {showHero && (
        <LandingHero
          onNewProject={() => setShowForm(true)}
          onQuickScan={() => setShowQuickScan(true)}
          onDismiss={toggleHero}
        />
      )}

      <PageHeader
        title="Course Projects & Scans"
        titleId="dashboard-heading"
        subtitle="Overview of course packages, scan history, defect review, and recent test activity."
        actions={
          <div className="dashboard-top-actions">
            {!showHero && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={toggleHero}
                aria-label="Show landing overview banner"
              >
                ✨ Show overview
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowQuickScan((s) => !s)}
              aria-expanded={showQuickScan}
            >
              ⚡ Quick scan URL
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowForm((s) => !s)}
              aria-expanded={showForm}
            >
              + New project
            </button>
          </div>
        }
      />

      {/* Toast feedback banner */}
      {toast && (
        <div className={`toast-banner toast-${toast.type}`} role="status" aria-live="polite">
          <span>{toast.message}</span>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setToast(null)} aria-label="Dismiss notification">
            ✕
          </button>
        </div>
      )}

      {/* KPI Stats Row */}
      <div className="dashboard-stats-grid" role="region" aria-label="Key metrics summary">
        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon">📚</span>
            <span className="stat-title">Courses / Projects</span>
          </div>
          <div className="stat-number">{metrics.totalProjects}</div>
          <div className="stat-sub">{metrics.withUrls} with saved course links</div>
        </div>

        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon">🔍</span>
            <span className="stat-title">Total Scans Run</span>
          </div>
          <div className="stat-number">{metrics.totalScans}</div>
          <div className="stat-sub">Across all configured projects</div>
        </div>

        <div className={`dash-stat-card ${metrics.activeScans > 0 ? 'stat-highlight' : ''}`}>
          <div className="stat-header">
            <span className="stat-icon">{metrics.activeScans > 0 ? '⏳' : '💤'}</span>
            <span className="stat-title">Active Scans</span>
          </div>
          <div className="stat-number">
            {metrics.activeScans > 0 && <span className="pulsing-dot" aria-hidden="true" />}
            {metrics.activeScans}
          </div>
          <div className="stat-sub">{metrics.activeScans > 0 ? 'Currently executing' : 'No scans in progress'}</div>
        </div>

        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon">⚠️</span>
            <span className="stat-title">Needs Review / Gaps</span>
          </div>
          <div className="stat-number">{metrics.partialOrGaps}</div>
          <div className="stat-sub">Scans with findings or gaps</div>
        </div>
      </div>

      {/* Collapsible Quick Scan Form */}
      {showQuickScan && (
        <QuickScanWidget
          projects={projects}
          onStarted={(runId) => {
            window.location.hash = `/runs/${runId}`;
          }}
          onClose={() => setShowQuickScan(false)}
        />
      )}

      {/* New Project Form Modal */}
      {showForm && (
        <NewProjectForm
          onCreated={(id, hasUrl) => {
            setShowForm(false);
            showToast('Project created successfully!');
            reload();
            if (hasUrl) {
              window.location.hash = `/projects/${id}/new-scan`;
            } else {
              window.location.hash = `/projects/${id}`;
            }
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Edit Project Form Modal */}
      {editingProject && (
        <EditProjectForm
          project={editingProject}
          onSaved={() => {
            setEditingProject(null);
            showToast(`Updated "${editingProject.name}"`);
            reload();
          }}
          onCancel={() => setEditingProject(null)}
        />
      )}

      {/* Duplicate Project Modal */}
      {duplicatingProject && (
        <DuplicateProjectForm
          project={duplicatingProject}
          onDuplicated={(newProj) => {
            setDuplicatingProject(null);
            showToast(`Duplicated project as "${newProj.name}"`);
            reload();
          }}
          onCancel={() => setDuplicatingProject(null)}
        />
      )}

      {/* Delete Project Confirmation Modal */}
      {deletingProject && (
        <DeleteProjectModal
          project={deletingProject}
          onDeleted={() => {
            const name = deletingProject.name;
            setDeletingProject(null);
            showToast(`Deleted project "${name}"`, 'info');
            reload();
          }}
          onCancel={() => setDeletingProject(null)}
        />
      )}

      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data ? (
        <Loading label="Loading courses and test history…" />
      ) : data.length === 0 ? (
        <Empty title="No course projects configured">
          <p>A project holds the scans, issues, evidence, and reports for one course package or URL.</p>
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
              Create your first project
            </button>
          </div>
        </Empty>
      ) : (
        <>
          {/* Recent Activity Table (if there are runs) */}
          {recentScans.length > 0 && (
            <div className="card recent-activity-card">
              <div className="section-header">
                <h2>Recent Scan Activity</h2>
                <span className="muted">Latest 5 executions across courses</span>
              </div>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Recent scans table">
                <table className="table recent-table">
                  <thead>
                    <tr>
                      <th scope="col">Project / Course</th>
                      <th scope="col">Status</th>
                      <th scope="col">Scan Started</th>
                      <th scope="col">Total Scans</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentScans.map((p) => (
                      <tr key={`recent-${p.id}`}>
                        <td>
                          <strong>
                            <Link to={`/projects/${p.id}`}>{p.name}</Link>
                          </strong>
                          {p.courseUrl && (
                            <span className="table-subtext" title={p.courseUrl}>
                              {hostPath(p.courseUrl)}
                            </span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={p.lastRun!.status} />
                        </td>
                        <td>{formatDate(p.lastRun!.queuedAt)}</td>
                        <td>{p.runCount}</td>
                        <td>
                          <a
                            className="btn btn-small"
                            href={`#/runs/${p.lastRun!.id}`}
                            aria-label={`View latest results for ${p.name}`}
                          >
                            View results
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Project Catalog Header & Controls */}
          <div className="catalog-header">
            <div className="catalog-title-row">
              <h2>Course Projects ({projects.length})</h2>
              <span className="muted" role="status">
                {filtered.length === projects.length ? `${projects.length} displayed` : `${filtered.length} of ${projects.length} matching`}
              </span>
            </div>

            <div className="catalog-controls">
              <div className="search-box">
                <input
                  id="project-search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, description, or URL…"
                  aria-label="Search projects"
                />
              </div>

              <div className="filter-pills" role="group" aria-label="Filter projects by scan status">
                <button
                  type="button"
                  className={`filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  All ({projects.length})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${statusFilter === 'active' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('active')}
                >
                  Active ({metrics.activeScans})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${statusFilter === 'scanned' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('scanned')}
                >
                  Tested ({projects.filter((p) => p.runCount > 0).length})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${statusFilter === 'unscanned' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('unscanned')}
                >
                  No Scans ({projects.filter((p) => p.runCount === 0).length})
                </button>
              </div>

              <div className="sort-dropdown">
                <label htmlFor="sort-select" className="sr-only">Sort projects</label>
                <select id="sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortOption)}>
                  <option value="recent">Sort: Most Recent Activity</option>
                  <option value="name">Sort: Alphabetical (A-Z)</option>
                  <option value="scans">Sort: Most Scans</option>
                </select>
              </div>
            </div>
          </div>

          {/* Projects Card Grid */}
          {filtered.length === 0 ? (
            <Empty title="No projects match your filter">
              <p>Try clearing your search term or selecting a different status filter.</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('all');
                }}
              >
                Reset filters
              </button>
            </Empty>
          ) : (
            <div className="dashboard-project-grid">
              {filtered.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onEdit={() => setEditingProject(p)}
                  onDuplicate={() => setDuplicatingProject(p)}
                  onDelete={() => setDeletingProject(p)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LandingHero({
  onNewProject,
  onQuickScan,
  onDismiss,
}: {
  onNewProject: () => void;
  onQuickScan: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="landing-hero-card" role="region" aria-label="Course QA Platform Overview">
      <div className="landing-hero-top">
        <div className="landing-hero-badge">
          <span className="hero-sparkle" aria-hidden="true">✨</span> Evidence-Backed eLearning Quality Assurance
        </div>
        <button
          type="button"
          className="btn btn-quiet btn-small hero-dismiss-btn"
          onClick={onDismiss}
          aria-label="Hide overview banner"
        >
          Hide banner ✕
        </button>
      </div>

      <div className="landing-hero-main">
        <h1 className="landing-hero-title">
          Automated QA Scanning for Digital Courses
        </h1>
        <p className="landing-hero-desc">
          Inspect Rise 360, Storyline 360, SCORM 1.2/2004 packages, and custom HTML5 lessons in a secure, local sandbox. Detect broken interactions, accessibility violations, and runtime defects with verifiable DOM and screenshot evidence.
        </p>

        <div className="landing-hero-actions">
          <button type="button" className="btn btn-primary" onClick={onNewProject}>
            + Create New Project
          </button>
          <button type="button" className="btn btn-secondary" onClick={onQuickScan}>
            ⚡ Quick Scan URL
          </button>
          <a href="#/library" className="btn btn-quiet">
            📖 Browse 72+ Test Rules
          </a>
        </div>
      </div>

      <div className="landing-hero-features">
        <div className="hero-feature-item">
          <span className="feature-icon" aria-hidden="true">🔍</span>
          <div className="feature-text">
            <strong>Functional Traversal</strong>
            <p>Tabs, accordions, modals, branches & behavior-rule all-click validation</p>
          </div>
        </div>

        <div className="hero-feature-item">
          <span className="feature-icon" aria-hidden="true">♿</span>
          <div className="feature-text">
            <strong>WCAG 2.2 & A11Y</strong>
            <p>Axe-core audits, 320px reflow heuristics, keyboard traps & containment</p>
          </div>
        </div>

        <div className="hero-feature-item">
          <span className="feature-icon" aria-hidden="true">📦</span>
          <div className="feature-text">
            <strong>SCORM 1.2 & 2004</strong>
            <p>Direct ZIP inspection, CMI lifecycle tracking & resume simulation</p>
          </div>
        </div>

        <div className="hero-feature-item">
          <span className="feature-icon" aria-hidden="true">🔒</span>
          <div className="feature-text">
            <strong>100% Local & Zero-AI</strong>
            <p>Deterministic local execution, zero network leakage & Excel exports</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project: p,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  project: ProjectListItem;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="project-dashboard-card">
      <div className="card-top">
        <div className="card-title-group">
          <h3 className="project-card-heading">
            <Link to={`/projects/${p.id}`}>{p.name}</Link>
          </h3>
          {p.isDemo && <span className="badge badge-demo">Demo Course</span>}
        </div>
        <div className="card-top-right">
          {p.lastRun && <StatusBadge status={p.lastRun.status} />}
          <div className="card-dropdown-container">
            <button
              type="button"
              className="btn btn-quiet btn-small card-options-btn"
              onClick={() => setShowMenu((s) => !s)}
              aria-label={`Options for ${p.name}`}
              aria-expanded={showMenu}
            >
              ⋮
            </button>
            {showMenu && (
              <>
                <div className="dropdown-overlay" onClick={() => setShowMenu(false)} />
                <div className="card-dropdown-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setShowMenu(false);
                      onEdit();
                    }}
                  >
                    ✏️ Edit project details
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setShowMenu(false);
                      onDuplicate();
                    }}
                  >
                    📋 Duplicate project
                  </button>
                  {p.runCount > 0 && (
                    <a
                      role="menuitem"
                      className="menu-item"
                      href={`/api/projects/${encodeURIComponent(p.id)}/export.xlsx`}
                      download
                      onClick={() => setShowMenu(false)}
                    >
                      📊 Export Excel report
                    </a>
                  )}
                  <a
                    role="menuitem"
                    className="menu-item"
                    href={`#/projects/${p.id}`}
                    onClick={() => setShowMenu(false)}
                  >
                    📜 View scan history
                  </a>
                  <hr className="menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item text-danger"
                    onClick={() => {
                      setShowMenu(false);
                      onDelete();
                    }}
                  >
                    🗑️ Delete project
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {p.description ? (
        <p className="project-desc">{p.description}</p>
      ) : (
        <p className="project-desc muted italic">No description provided</p>
      )}

      {p.courseUrl ? (
        <div className="project-target-box">
          <span className="target-label">Target:</span>
          <span className="target-url" title={p.courseUrl}>
            {hostPath(p.courseUrl)}
          </span>
          <CopyButton text={p.courseUrl} label="Copy address" />
        </div>
      ) : (
        <div className="project-target-box muted">
          <span className="target-label">Target:</span>
          <span>Package ZIP upload or URL required</span>
        </div>
      )}

      <div className="project-card-footer">
        <div className="footer-meta">
          <span className="meta-item">
            <strong>{p.runCount}</strong> scan{p.runCount === 1 ? '' : 's'}
          </span>
          {p.lastRun && (
            <span className="meta-item muted">
              Last: {formatDate(p.lastRun.queuedAt)}
            </span>
          )}
        </div>

        <div className="footer-actions">
          <a className="btn btn-primary btn-small" href={`#/projects/${p.id}/new-scan`}>
            {p.runCount > 0 ? 'New Scan' : 'Start First Scan'}
          </a>
          {p.lastRun && (
            <a
              className="btn btn-secondary btn-small"
              href={`#/runs/${p.lastRun.id}`}
              aria-label={`View latest results for ${p.name}`}
            >
              View latest results
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function QuickScanWidget({
  projects,
  onStarted,
  onClose,
}: {
  projects: ProjectListItem[];
  onStarted: (runId: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [newProjectName, setNewProjectName] = useState('');
  const [isNewProject, setIsNewProject] = useState(projects.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(undefined);

    try {
      let targetProjectId = projectId;
      if (isNewProject || !targetProjectId) {
        const pName = newProjectName.trim() || hostPath(url) || 'New Scan Project';
        const newProj = await api.createProject({ name: pName, courseUrl: url.trim() });
        targetProjectId = newProj.id;
      }

      const scan = await api.createScan(targetProjectId, {
        url: url.trim(),
        explore: true,
        accessibility: true,
        layout: true,
        functional: true,
        qaProfile: 'functional',
      });
      onStarted(scan.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="card quick-scan-widget">
      <div className="section-header">
        <h3>⚡ Quick Launch: Scan Course URL</h3>
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose} aria-label="Close quick scan">
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit} className="quick-scan-form">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="qs-url">Course URL to Scan</label>
            <input
              id="qs-url"
              type="url"
              required
              placeholder="https://published-course.example.com/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="qs-project">Target Project</label>
            {!isNewProject && projects.length > 0 ? (
              <div className="inline-select-group">
                <select id="qs-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => setIsNewProject(true)}>
                  + Create New Project
                </button>
              </div>
            ) : (
              <div className="inline-select-group">
                <input
                  id="qs-new-name"
                  type="text"
                  placeholder="Project name (e.g. Compliance Module)"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                />
                {projects.length > 0 && (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setIsNewProject(false)}>
                    Use Existing Project
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="alert alert-error">{error}</p>}

        <div className="quick-scan-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Launching Scan…' : '🚀 Start Functional Scan'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (id: string, hasUrl: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [courseUrl, setCourseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.createProject({ name, courseUrl: courseUrl || undefined, description: description || undefined });
      onCreated(p.id, Boolean(courseUrl));
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => i.message).join(' ') || err.message) : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-project-heading">
      <form className="card form modal-card" onSubmit={submit}>
        <div className="section-header">
          <h2 id="new-project-heading">Create New Course Project</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close modal">
            ✕
          </button>
        </div>

        <div className="field">
          <label htmlFor="p-name">Project Name</label>
          <input
            id="p-name"
            required
            maxLength={120}
            placeholder="e.g. Information Security 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="p-url">Published Course URL (Optional)</label>
          <input
            id="p-url"
            type="url"
            inputMode="url"
            placeholder="https://..."
            value={courseUrl}
            onChange={(e) => setCourseUrl(e.target.value)}
            aria-describedby="p-url-help"
          />
          <p id="p-url-help" className="help">
            Add a web link now to prefill your scan, or upload an Articulate Rise / Storyline package ZIP later.
          </p>
        </div>

        <div className="field">
          <label htmlFor="p-desc">Description (Optional)</label>
          <textarea
            id="p-desc"
            rows={2}
            maxLength={2000}
            placeholder="Notes on version, LMS target, or authoring tool..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions modal-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating Project…' : 'Create Project'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function EditProjectForm({
  project,
  onSaved,
  onCancel,
}: {
  project: ProjectListItem;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [courseUrl, setCourseUrl] = useState(project.courseUrl ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.updateProject(project.id, {
        name: name.trim(),
        courseUrl: courseUrl.trim() || null,
        description: description.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => i.message).join(' ') || err.message) : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-project-heading">
      <form className="card form modal-card" onSubmit={submit}>
        <div className="section-header">
          <h2 id="edit-project-heading">Edit Project Details</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close edit modal">
            ✕
          </button>
        </div>

        <div className="field">
          <label htmlFor="edit-p-name">Project Name</label>
          <input
            id="edit-p-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="edit-p-url">Published Course URL</label>
          <input
            id="edit-p-url"
            type="url"
            inputMode="url"
            placeholder="https://..."
            value={courseUrl}
            onChange={(e) => setCourseUrl(e.target.value)}
          />
          <p className="help">Update the default URL targeted for scans in this project.</p>
        </div>

        <div className="field">
          <label htmlFor="edit-p-desc">Description</label>
          <textarea
            id="edit-p-desc"
            rows={2}
            maxLength={2000}
            placeholder="Notes or version info..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions modal-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving Changes…' : 'Save Changes'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function DuplicateProjectForm({
  project,
  onDuplicated,
  onCancel,
}: {
  project: ProjectListItem;
  onDuplicated: (newProject: { id: string; name: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(`Copy of ${project.name}`);
  const [courseUrl, setCourseUrl] = useState(project.courseUrl ?? '');
  const [description, setDescription] = useState(project.description ? `${project.description} (Copy)` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.createProject({
        name: name.trim(),
        courseUrl: courseUrl.trim() || undefined,
        description: description.trim() || undefined,
      });
      onDuplicated(p);
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => i.message).join(' ') || err.message) : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dup-project-heading">
      <form className="card form modal-card" onSubmit={submit}>
        <div className="section-header">
          <h2 id="dup-project-heading">Duplicate Project</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close duplicate modal">
            ✕
          </button>
        </div>

        <p className="modal-intro muted">
          Creates a new project copy with the same course link and settings. Existing scan history and findings remain in the original project.
        </p>

        <div className="field">
          <label htmlFor="dup-p-name">New Project Name</label>
          <input
            id="dup-p-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="dup-p-url">Course URL</label>
          <input
            id="dup-p-url"
            type="url"
            inputMode="url"
            placeholder="https://..."
            value={courseUrl}
            onChange={(e) => setCourseUrl(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="dup-p-desc">Description</label>
          <textarea
            id="dup-p-desc"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions modal-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Duplicating…' : 'Duplicate Project'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteProjectModal({
  project,
  onDeleted,
  onCancel,
}: {
  project: ProjectListItem;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const isRunning = project.lastRun?.status === 'running' || project.lastRun?.status === 'queued';

  const handleDelete = async () => {
    if (busy || isRunning) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-project-heading">
      <div className="card modal-card delete-modal">
        <div className="section-header">
          <h2 id="del-project-heading" className="text-danger">⚠️ Delete Project</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close delete modal">
            ✕
          </button>
        </div>

        <p>
          Are you sure you want to delete <strong>&ldquo;{project.name}&rdquo;</strong>?
        </p>

        <div className="delete-impact-box">
          <p className="impact-title">This will permanently remove:</p>
          <ul>
            <li><strong>{project.runCount}</strong> scan run{project.runCount === 1 ? '' : 's'} and execution histories</li>
            <li>All stored screenshots, logs, and crawl artifacts</li>
            <li>Logged defects, findings, and reviewer workflow dispositions</li>
          </ul>
        </div>

        {isRunning && (
          <p className="alert alert-warn" role="alert">
            ⚠️ This project currently has an active scan running or queued. You must cancel active scans before deleting the project.
          </p>
        )}

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions modal-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={busy || isRunning}
          >
            {busy ? 'Deleting…' : 'Yes, Delete Project'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
