const PAGES: Record<string, { phase: string; what: string; cli: string }> = {
  sort: {
    phase: 'P1',
    what: 'Pick a folder, preview the buckets the local model chooses, then apply exactly that preview or undo it.',
    cli: 'photosort.cmd sort "<folder>" --action report',
  },
  group: {
    phase: 'P1',
    what: 'Describe an event in plain words ("birthday party last Sunday") and move just those photos and videos into a folder.',
    cli: 'photosort.cmd group "<folder>" "birthday party last Sunday" --action report',
  },
  search: {
    phase: 'P2',
    what: 'Search your indexed photos and videos in plain words, browse a fast gallery and play videos.',
    cli: 'photosort.cmd search "kids at the beach"',
  },
  faces: {
    phase: 'P4',
    what: 'Tag known people with the face workers on your LAN, and review the results per person.',
    cli: 'photosort.cmd faces "<folder>" --people "<people folder>" --recursive',
  },
  runs: {
    phase: 'P3',
    what: 'Every sort, group and index run with its duration, what moved where, and a previewed undo.',
    cli: 'photosort.cmd undo "<folder>\\_photosort_journal.jsonl"',
  },
  cluster: {
    phase: 'P3',
    what: 'The PAIR nodes, their models, load and latency, and an alert if any request is ever routed off your LAN.',
    cli: 'photosort.cmd check',
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
