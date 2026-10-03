import { useEffect, useRef, useState } from 'react';
import { FindingPage } from './pages/FindingPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/RunPage';

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
  const [, section, id] = route.split('/');
  if (section === 'projects' && id) return <ProjectPage id={id} />;
  if (section === 'runs' && id) return <RunPage id={id} />;
  if (section === 'findings' && id) return <FindingPage id={id} />;
  return <ProjectsPage />;
}

export function App() {
  const route = useHashRoute();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the main region on navigation so keyboard and screen-reader users land on the new page.
  useEffect(() => {
    mainRef.current?.focus();
  }, [route]);

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), mainRef.current?.focus())}>
        Skip to content
      </a>
      <header className="topbar">
        <a href="#/" className="brand">
          Course QA Automation
        </a>
        <span className="topbar-note">Local · no AI · evidence-backed</span>
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
