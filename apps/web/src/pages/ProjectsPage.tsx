import { type FormEvent, useMemo, useState } from 'react';
import type { RunStatus } from '@cqa/shared';
import { ApiError, api, type ProjectListItem } from '../api';
import { CopyButton, Empty, ErrorBox, Link, Loading, PageHeader, StatusBadge, formatDate, hostPath, useLoader } from '../components/ui';

type StatusFilter = 'all' | 'active' | 'scanned' | 'unscanned';
type SortOption = 'recent' | 'name' | 'scans';
type ViewMode = 'grid' | 'table';

export function ProjectsPage() {
  const { data, error, reload } = useLoader(
    () => api.listProjects(),
    [],
    (list) => list.some((p) => p.lastRun?.status === 'running' || p.lastRun?.status === 'queued')
  );

  const [showForm, setShowForm] = useState(false);
  const [showQuickScan, setShowQuickScan] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem('cqa_projects_view') as ViewMode) || 'grid';
    } catch {
      return 'grid';
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

  const handleSetViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('cqa_projects_view', mode);
    } catch {
      // ignore storage error
    }
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
      <PageHeader
        title="Courses & Projects"
        titleId="dashboard-heading"
        subtitle={`${projects.length} course project${projects.length === 1 ? '' : 's'} · ${metrics.totalScans} scan execution${metrics.totalScans === 1 ? '' : 's'}${metrics.activeScans > 0 ? ` · ${metrics.activeScans} scan in progress` : ''}`}
        actions={
          <div className="dashboard-top-actions">
            {recentScans.length > 0 && (
              <button
                type="button"
                className={`btn btn-small ${showRecent ? 'btn-secondary' : 'btn-quiet'}`}
                onClick={() => setShowRecent((s) => !s)}
                aria-expanded={showRecent}
              >
                📜 {showRecent ? 'Hide Recent Scans' : 'Recent Scans'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setShowQuickScan((s) => !s)}
              aria-expanded={showQuickScan}
            >
              ⚡ Quick scan URL
            </button>
            <button
              type="button"
              className="btn btn-primary btn-small"
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

      {/* Streamlined KPI Stats Row */}
      <div className="dashboard-stats-grid" role="region" aria-label="Key metrics summary">
        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon" aria-hidden="true">📚</span>
            <span className="stat-title">Courses</span>
          </div>
          <div className="stat-number">{metrics.totalProjects}</div>
          <div className="stat-sub">{metrics.withUrls} with course links · {metrics.totalProjects - metrics.withUrls} packages</div>
        </div>

        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon" aria-hidden="true">🔍</span>
            <span className="stat-title">Total Scans</span>
          </div>
          <div className="stat-number">{metrics.totalScans}</div>
          <div className="stat-sub">Across all test runs</div>
        </div>

        <div className={`dash-stat-card ${metrics.activeScans > 0 ? 'stat-highlight' : ''}`}>
          <div className="stat-header">
            <span className="stat-icon" aria-hidden="true">{metrics.activeScans > 0 ? '⚡' : '💤'}</span>
            <span className="stat-title">Live Status</span>
          </div>
          <div className="stat-number">
            {metrics.activeScans > 0 && <span className="pulsing-dot" aria-hidden="true" />}
            {metrics.activeScans > 0 ? `${metrics.activeScans} Running` : 'Idle'}
          </div>
          <div className="stat-sub">{metrics.activeScans > 0 ? 'Deep traversal active' : 'Ready for scans'}</div>
        </div>

        <div className="dash-stat-card">
          <div className="stat-header">
            <span className="stat-icon" aria-hidden="true">🎯</span>
            <span className="stat-title">Audit Results</span>
          </div>
          <div className="stat-number">{metrics.completedScans + metrics.partialOrGaps}</div>
          <div className="stat-sub">{metrics.completedScans} completed · {metrics.partialOrGaps} partial/reviews</div>
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
          {/* Recent Activity Table (toggleable) */}
          {showRecent && recentScans.length > 0 && (
            <div className="card" style={{ marginBottom: '1.25rem', borderLeft: '4px solid #2563eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Recent Scan Activity ({recentScans.length} latest runs)</h3>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => setShowRecent(false)} aria-label="Close recent scans">
                  ✕
                </button>
              </div>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Recent scans table">
                <table className="table recent-table">
                  <thead>
                    <tr>
                      <th scope="col">Course Project</th>
                      <th scope="col">Target</th>
                      <th scope="col">Status</th>
                      <th scope="col">Scan Time</th>
                      <th scope="col">Scans</th>
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
                        </td>
                        <td>
                          {p.courseUrl ? (
                            <span className="table-subtext" title={p.courseUrl}>
                              {hostPath(p.courseUrl)}
                            </span>
                          ) : (
                            <span className="muted" style={{ fontSize: '0.82rem' }}>Uploaded Package</span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={p.lastRun!.status} />
                        </td>
                        <td style={{ fontSize: '0.85rem' }}>{formatDate(p.lastRun!.queuedAt)}</td>
                        <td>{p.runCount}</td>
                        <td>
                          <a
                            className="btn btn-small btn-primary"
                            href={`#/runs/${p.lastRun!.id}`}
                            aria-label={`View latest results for ${p.name}`}
                          >
                            View report
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
              <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Courses ({filtered.length}{filtered.length !== projects.length ? ` of ${projects.length}` : ''})</h2>

              {/* View Switcher: Grid vs Table */}
              <div className="view-mode-toggle" role="group" aria-label="Display view mode" style={{ display: 'flex', gap: '0.25rem', background: '#f1f5f9', padding: '0.2rem', borderRadius: '6px' }}>
                <button
                  type="button"
                  className={`btn btn-small ${viewMode === 'grid' ? 'btn-secondary' : 'btn-quiet'}`}
                  style={{ padding: '0.25rem 0.6rem', fontSize: '0.82rem', borderRadius: '4px' }}
                  onClick={() => handleSetViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  title="Card Grid View"
                >
                  ⊞ Cards
                </button>
                <button
                  type="button"
                  className={`btn btn-small ${viewMode === 'table' ? 'btn-secondary' : 'btn-quiet'}`}
                  style={{ padding: '0.25rem 0.6rem', fontSize: '0.82rem', borderRadius: '4px' }}
                  onClick={() => handleSetViewMode('table')}
                  aria-pressed={viewMode === 'table'}
                  title="Compact Table List View"
                >
                  ☰ Table List
                </button>
              </div>
            </div>

            <div className="catalog-controls">
              <div className="search-box">
                <input
                  id="project-search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by course name, target URL, or notes…"
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
                  Untested ({projects.filter((p) => p.runCount === 0).length})
                </button>
              </div>

              <div className="sort-dropdown">
                <label htmlFor="sort-select" className="sr-only">Sort projects</label>
                <select id="sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortOption)}>
                  <option value="recent">Sort: Most Recent</option>
                  <option value="name">Sort: Alphabetical (A-Z)</option>
                  <option value="scans">Sort: Most Scans</option>
                </select>
              </div>
            </div>
          </div>

          {/* Project List / Grid View */}
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
          ) : viewMode === 'table' ? (
            /* Streamlined Table View */
            <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Courses list table">
                <table className="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: '32%' }}>Course / Project</th>
                      <th scope="col" style={{ width: '22%' }}>Target / Source</th>
                      <th scope="col" style={{ width: '12%' }}>Last Status</th>
                      <th scope="col" style={{ width: '14%' }}>Last Scan</th>
                      <th scope="col" style={{ width: '6%', textAlign: 'center' }}>Scans</th>
                      <th scope="col" style={{ width: '14%', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => (
                      <ProjectTableRow
                        key={p.id}
                        project={p}
                        onEdit={() => setEditingProject(p)}
                        onDuplicate={() => setDuplicatingProject(p)}
                        onDelete={() => setDeletingProject(p)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* Streamlined Card Grid View */
            <div className="dashboard-project-grid" style={{ marginTop: '0.5rem' }}>
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

function ProjectTableRow({
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
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <strong>
            <Link to={`/projects/${p.id}`}>{p.name}</Link>
          </strong>
          {p.isDemo && <span className="badge badge-demo">Demo</span>}
        </div>
        {p.description && (
          <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: '0.15rem' }}>
            {p.description}
          </div>
        )}
      </td>
      <td>
        {p.courseUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.82rem', fontFamily: 'monospace', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.courseUrl}>
              {hostPath(p.courseUrl)}
            </span>
            <CopyButton text={p.courseUrl} label="Copy address" />
          </div>
        ) : (
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>📦 Package ZIP</span>
        )}
      </td>
      <td>
        {p.lastRun ? <StatusBadge status={p.lastRun.status} /> : <span style={{ fontSize: '0.8rem', color: '#475569' }}>Untested</span>}
      </td>
      <td style={{ fontSize: '0.82rem', color: '#475569' }}>
        {p.lastRun?.queuedAt ? formatDate(p.lastRun.queuedAt) : '—'}
      </td>
      <td style={{ textAlign: 'center', fontWeight: 600, fontSize: '0.9rem' }}>
        {p.runCount}
      </td>
      <td>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.4rem' }}>
          <a
            className="btn btn-small btn-primary"
            href={`#/projects/${p.id}/new-scan`}
            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
          >
            Scan
          </a>
          {p.lastRun && (
            <a
              className="btn btn-small btn-secondary"
              href={`#/runs/${p.lastRun.id}`}
              style={{ padding: '0.25rem 0.55rem', fontSize: '0.8rem' }}
              title="View latest scan results"
            >
              Report
            </a>
          )}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setShowMenu((s) => !s)}
              aria-label={`Options for ${p.name}`}
              style={{ padding: '0.2rem 0.45rem', fontSize: '0.9rem' }}
            >
              ⋮
            </button>
            {showMenu && (
              <>
                <div className="dropdown-overlay" onClick={() => setShowMenu(false)} />
                <div className="card-dropdown-menu" role="menu" style={{ right: 0, top: '100%', minWidth: '11rem' }}>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setShowMenu(false);
                      onEdit();
                    }}
                  >
                    ✏️ Edit details
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
                    📋 Duplicate
                  </button>
                  {p.runCount > 0 && (
                    <a
                      role="menuitem"
                      className="menu-item"
                      href={`/api/projects/${encodeURIComponent(p.id)}/export.xlsx`}
                      download
                      onClick={() => setShowMenu(false)}
                    >
                      📊 Export Excel
                    </a>
                  )}
                  <a
                    role="menuitem"
                    className="menu-item"
                    href={`#/projects/${p.id}`}
                    onClick={() => setShowMenu(false)}
                  >
                    📜 History
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
                    🗑️ Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </td>
    </tr>
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
    <div className="project-dashboard-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
      <div className="card-top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div className="card-title-group" style={{ minWidth: 0, flex: '1 1 auto' }}>
          <h3 className="project-card-heading" style={{ fontSize: '1.05rem', margin: 0, lineHeight: 1.3 }}>
            <Link to={`/projects/${p.id}`}>
              {p.name}
            </Link>
          </h3>
          {p.isDemo && <span className="badge badge-demo" style={{ marginTop: '0.2rem' }}>Demo Course</span>}
        </div>
        <div className="card-top-right" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
          {p.lastRun && <StatusBadge status={p.lastRun.status} />}
          <div className="card-dropdown-container" style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-quiet btn-small card-options-btn"
              onClick={() => setShowMenu((s) => !s)}
              aria-label={`Options for ${p.name}`}
              aria-expanded={showMenu}
              style={{ padding: '0.2rem 0.45rem' }}
            >
              ⋮
            </button>
            {showMenu && (
              <>
                <div className="dropdown-overlay" onClick={() => setShowMenu(false)} />
                <div className="card-dropdown-menu" role="menu" style={{ right: 0 }}>
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
        <p className="project-desc" style={{ fontSize: '0.85rem', color: '#475569', margin: 0, lineHeight: 1.35 }}>{p.description}</p>
      ) : null}

      {p.courseUrl ? (
        <div className="project-target-box" style={{ padding: '0.35rem 0.55rem', borderRadius: '6px', background: '#f8fafc', border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span style={{ fontSize: '0.78rem', color: '#475569', fontWeight: 600 }}>URL:</span>
          <span className="target-url" title={p.courseUrl} style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
            {hostPath(p.courseUrl)}
          </span>
          <CopyButton text={p.courseUrl} label="Copy address" />
        </div>
      ) : (
        <div style={{ fontSize: '0.78rem', color: '#475569', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span>📦</span>
          <span>SCORM / HTML5 ZIP package project</span>
        </div>
      )}

      <div className="project-card-footer" style={{ marginTop: 'auto', paddingTop: '0.65rem', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="footer-meta" style={{ fontSize: '0.8rem', color: '#475569' }}>
          <span><strong>{p.runCount}</strong> scan{p.runCount === 1 ? '' : 's'}</span>
          {p.lastRun?.queuedAt && (
            <span style={{ marginLeft: '0.4rem', color: '#475569' }}>
              · {formatDate(p.lastRun.queuedAt)}
            </span>
          )}
        </div>

        <div className="footer-actions" style={{ display: 'flex', gap: '0.35rem' }}>
          {p.lastRun && (
            <a
              className="btn btn-secondary btn-small"
              href={`#/runs/${p.lastRun.id}`}
              aria-label={`View latest results for ${p.name}`}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.55rem' }}
            >
              Report
            </a>
          )}
          <a
            className="btn btn-primary btn-small"
            href={`#/projects/${p.id}/new-scan`}
            style={{ fontSize: '0.8rem', padding: '0.25rem 0.65rem' }}
          >
            {p.runCount > 0 ? 'New Scan' : 'Start Scan'}
          </a>
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
    <div className="card quick-scan-widget" style={{ marginBottom: '1.25rem', borderLeft: '4px solid #2563eb' }}>
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>⚡ Quick Launch: Scan Course URL</h3>
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose} aria-label="Close quick scan">
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit} className="quick-scan-form">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="qs-url" style={{ fontWeight: 600, fontSize: '0.85rem' }}>Course URL to Scan</label>
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
            <label htmlFor="qs-project" style={{ fontWeight: 600, fontSize: '0.85rem' }}>Target Project</label>
            {!isNewProject && projects.length > 0 ? (
              <div className="inline-select-group" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <select id="qs-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ flex: '1 1 auto' }}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => setIsNewProject(true)}>
                  + New
                </button>
              </div>
            ) : (
              <div className="inline-select-group" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  id="qs-new-name"
                  type="text"
                  placeholder="Project name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  style={{ flex: '1 1 auto' }}
                />
                {projects.length > 0 && (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setIsNewProject(false)}>
                    Existing
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="alert alert-error">{error}</p>}

        <div className="quick-scan-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
            {busy ? 'Launching Scan…' : '🚀 Start Functional Scan'}
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
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
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 id="new-project-heading" style={{ margin: 0, fontSize: '1.15rem' }}>Create New Course Project</h2>
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

        <div className="actions modal-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
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
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 id="edit-project-heading" style={{ margin: 0, fontSize: '1.15rem' }}>Edit Project Details</h2>
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

        <div className="actions modal-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
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
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 id="dup-project-heading" style={{ margin: 0, fontSize: '1.15rem' }}>Duplicate Project</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close duplicate modal">
            ✕
          </button>
        </div>

        <p className="modal-intro muted" style={{ fontSize: '0.85rem' }}>
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

        <div className="actions modal-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
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
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 id="del-project-heading" className="text-danger" style={{ margin: 0, fontSize: '1.15rem' }}>⚠️ Delete Project</h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel} aria-label="Close delete modal">
            ✕
          </button>
        </div>

        <p>
          Are you sure you want to delete <strong>&ldquo;{project.name}&rdquo;</strong>?
        </p>

        <div className="delete-impact-box" style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '0.75rem', fontSize: '0.85rem', color: '#991b1b', marginBottom: '1rem' }}>
          <p className="impact-title" style={{ fontWeight: 600, margin: '0 0 0.4rem 0' }}>This will permanently remove:</p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
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

        <div className="actions modal-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
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
