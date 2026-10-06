import { useEffect, useRef, useState } from 'react';
import { HelpPage } from './pages/AboutPage';
import { FindingPage } from './pages/FindingPage';
import { NewScanPage } from './pages/NewScanPage';
import { PackagePage } from './pages/PackagePage';
import { ProfilesPage } from './pages/ProfilesPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/RunPage';
import { splitRoute, useLoader } from './components/ui';
import { api } from './api';

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Page({ route }: { route: string }) {
  const { parts, query } = splitRoute(route);
  const [section, id, sub] = parts;
  if (section === 'projects' && id && sub === 'new-scan') return <NewScanPage projectId={id} presetUrl={query.get('url') ?? undefined} />;
  if (section === 'projects' && id) return <ProjectPage id={id} tab={sub} />;
  if (section === 'runs' && id) return <RunPage id={id} tab={sub} query={query} />;
  if (section === 'packages' && id) return <PackagePage id={id} />;
  if (section === 'help' || section === 'about') return <HelpPage />;
  if (section === 'profiles') return <ProfilesPage />;
  if (section === 'findings' && id) return <FindingPage id={id} />;
  return <ProjectsPage />;
}

const NAV = [
  { to: '/', label: 'Projects', match: (s?: string) => !s || s === 'projects' || s === 'runs' || s === 'findings' || s === 'packages' },
  { to: '/profiles', label: 'Client settings', match: (s?: string) => s === 'profiles' },
  { to: '/help', label: 'Help', match: (s?: string) => s === 'help' || s === 'about' },
];

export function App() {
  const route = useHashRoute();
  const mainRef = useRef<HTMLElement>(null);
  const section = splitRoute(route).parts[0];
  const session = useLoader(() => api.session(), []);
  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      window.location.assign('/login');
    }
  };

  // Move focus to the main region on navigation so keyboard and screen-reader users land on the new page.
  // Moving between tabs of the same page keeps the reader where they are.
  const lastPage = useRef('');
  useEffect(() => {
    const { parts } = splitRoute(route);
    const key = parts.slice(0, 2).join('/');
    if (key !== lastPage.current) mainRef.current?.focus();
    lastPage.current = key;
  }, [route]);

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), mainRef.current?.focus())}>
        Skip to content
      </a>
      <header className="topbar">
        <a href="#/" className="brand">
          Course QA
        </a>
        <nav aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <a href={`#${n.to}`} aria-current={n.match(section) ? 'page' : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {session.data?.lan ? (
          <span className="topbar-note topbar-session">
            LAN demo · signed in as {session.data.user}{' '}
            <button type="button" className="btn btn-small btn-signout" onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        ) : (
          <span className="topbar-note">Runs on this computer · no AI</span>
        )}
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="container">
        <Page route={route} />
      </main>
      <footer className="footer container">
        Automated checks show what was observed and tested. They do not establish full accessibility compliance, complete course coverage, or LMS compatibility.
      </footer>
    </>
  );
}
