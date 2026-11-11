const PAGES: Record<string, { phase: string; what: string; cli: string }> = {
  faces: {
    phase: 'P4',
    what: 'Tag known people with the face workers on your LAN, and review the results per person.',
    cli: 'photosort.cmd faces "<folder>" --people "<people folder>" --recursive',
  },
  settings: {
    phase: 'P4',
    what: 'Edit models, buckets, concurrency and face workers with validation (cloud models are refused).',
    cli: 'edit config.json',
  },
};

export function Placeholder({ page }: { page: string }) {
  const p = PAGES[page];
  if (!p) return null;
  return (
    <section className="card narrow">
      <span className="badge">{p.phase}</span>
      <p>{p.what}</p>
      <p className="muted small">Until then, the command line does the same:</p>
      <pre className="cli">{p.cli}</pre>
    </section>
  );
}
