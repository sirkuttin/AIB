/**
 * A doc's history in AIB's artifact versions store (artifacts/artifacts.ts): one `md` artifact per doc, one version per snapshot,
 * with `by` (who changed it since the last snapshot: "user", an agent's name, "file", or several joined by "+") and the doc's rev in
 * the version's note ("rev 57"). The artifact has no source path, so the artifact watcher leaves it alone; the Artifacts panel can
 * list it, and Compare/diff works on it like on any text artifact.
 */
import { ArtifactError, type ArtifactStore } from '../artifacts/artifacts.ts';

export interface HistoryDoc {
  name: string;
  projectRoot: string;
  artifactId: string | null;
}

export interface HistoryVersion {
  n: number;
  /** The doc's rev when it was taken. */
  rev: number | null;
  at: number;
  by: string;
  note: string;
  size: number;
}

export interface DocHistory {
  /** Record `text` as a new version; returns its number (null when nothing was recorded). Sets doc.artifactId on the first. */
  snapshot(
    doc: HistoryDoc,
    text: string,
    by: string,
    note: string,
  ): number | null;
  list(doc: HistoryDoc): HistoryVersion[];
  read(doc: HistoryDoc, n: number): string | null;
}

export class ArtifactHistory implements DocHistory {
  constructor(readonly store: () => ArtifactStore | null) {}

  snapshot(
    doc: HistoryDoc,
    text: string,
    by: string,
    note: string,
  ): number | null {
    const store = this.store();
    if (!store) return null;
    const data = new TextEncoder().encode(text);
    const entry = `${doc.name}.md`;
    if (doc.artifactId) {
      try {
        const [manifest] = store.addVersion(doc.artifactId, data, { entry, by, note });
        return manifest.versions[manifest.versions.length - 1].n;
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        doc.artifactId = null; // removed from the store: start a new history
      }
    }
    const manifest = store.create(null, doc.name, 'md', entry, data, { project: doc.projectRoot, by, note });
    doc.artifactId = manifest.id;
    return 1;
  }

  list(doc: HistoryDoc): HistoryVersion[] {
    const store = this.store();
    if (!store || !doc.artifactId) return [];
    try {
      return store.get(doc.artifactId).versions.map((v) => ({
        n: v.n,
        rev: /rev (\d+)/.test(v.note) ? Number(/rev (\d+)/.exec(v.note)![1]) : null,
        at: v.at,
        by: v.by,
        note: v.note,
        size: v.size,
      }));
    } catch (error) {
      if (error instanceof ArtifactError) return [];
      throw error;
    }
  }

  read(doc: HistoryDoc, n: number): string | null {
    const store = this.store();
    if (!store || !doc.artifactId) return null;
    try {
      const manifest = store.get(doc.artifactId);
      return new TextDecoder().decode(Deno.readFileSync(store.versionFile(manifest, n)));
    } catch (error) {
      if (
        error instanceof ArtifactError || error instanceof Deno.errors.NotFound
      ) return null;
      throw error;
    }
  }
}
