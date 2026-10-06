import { useRef, useState } from 'react';

/**
 * Evidence screenshot with a usable preview and an actual-size view.
 * The preview is a crop of the top of the image (labelled as a crop); the original file is never altered and is
 * always one click away, at fit-to-window, actual size, or zoomed.
 */
export function ScreenshotViewer({ src, alt, caption, title }: { src: string; alt: string; caption?: string; title?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number }>();

  if (failed) {
    return (
      <p className="alert alert-warn" role="status">
        This screenshot could not be loaded. The file may have been removed by retention settings. The finding and its other evidence are unchanged.
      </p>
    );
  }

  const open = () => {
    setZoom('fit');
    dialog.current?.showModal();
  };
  const imgStyle = zoom === 'fit' ? { maxWidth: '100%', height: 'auto' } : { width: size ? Math.round(size.w * zoom) : undefined, maxWidth: 'none' };

  return (
    <figure className="shot">
      <button type="button" className="shot-thumb" onClick={open} aria-label={`Open full screenshot${title ? `: ${title}` : ''}`}>
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        <span className="shot-hint">Click to open full screenshot</span>
      </button>
      <figcaption>
        {caption ?? 'Screenshot'}
        {size && size.h > 700 ? ' · preview shows the top of a tall screen' : ''}
      </figcaption>
      <dialog ref={dialog} className="viewer" aria-label={title ?? 'Screenshot viewer'}>
        <div className="viewer-bar">
          <strong>{title ?? caption ?? 'Screenshot'}</strong>
          <div className="viewer-controls" role="group" aria-label="Zoom">
            <button type="button" className="btn btn-small" onClick={() => setZoom('fit')} aria-pressed={zoom === 'fit'}>
              Fit to window
            </button>
            <button type="button" className="btn btn-small" onClick={() => setZoom(1)} aria-pressed={zoom === 1}>
              Actual size
            </button>
            <button type="button" className="btn btn-small" onClick={() => setZoom((z) => Math.min(4, (z === 'fit' ? 1 : z) + 0.25))} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="btn btn-small" onClick={() => setZoom((z) => Math.max(0.25, (z === 'fit' ? 1 : z) - 0.25))} aria-label="Zoom out">
              −
            </button>
            <a className="btn btn-small" href={src} target="_blank" rel="noreferrer">
              Open original in a new tab
            </a>
            <button type="button" className="btn btn-small btn-primary" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
        </div>
        <div className="viewer-body" tabIndex={0} role="region" aria-label="Screenshot (scrolls)">
          <img src={src} alt={alt} style={imgStyle} />
        </div>
        <p className="help">
          {size ? `Original image: ${size.w} × ${size.h} px. ` : ''}Shown unaltered. Press Escape to close.
        </p>
      </dialog>
    </figure>
  );
}
