// Repository state from the GitHub REST API: default branch, latest commits, open pull requests and the latest CI run.
// Shared by the Worker (GITHUB_TOKEN secret, from the cron tick) and the local collector (scripts/compass-sync.ts,
// using `gh auth token`). The token is only ever sent to api.github.com.
import { z } from "zod";

export const REPO_RX = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export const githubSignalSchema = z.object({
  repo: z.string().regex(REPO_RX),
  defaultBranch: z.string().max(200),
  pushedAt: z.string().max(40).nullable(),
  commits: z.array(z.object({ sha: z.string().max(12), at: z.string().max(40), subject: z.string().max(200), author: z.string().max(80).nullable() }).strict()).max(5),
  openPrs: z.array(z.object({ number: z.number().int(), title: z.string().max(200), updatedAt: z.string().max(40), draft: z.boolean() }).strict()).max(10),
  ci: z.object({ name: z.string().max(120), status: z.string().max(30), conclusion: z.string().max(30).nullable(), at: z.string().max(40), url: z.string().max(400) }).strict().nullable(),
}).strict();
export type GithubSignal = z.infer<typeof githubSignalSchema>;

/** Parses "https://github.com/Owner/Name.git" or "git@github.com:Owner/Name.git" into "Owner/Name". */
export function repoSlug(remote: string | null | undefined): string | null {
  const m = (remote ?? "").trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const slug = m ? `${m[1]}/${m[2]}` : null;
  return slug && REPO_RX.test(slug) ? slug : null;
}

export async function repoState(repo: string, token: string, fetcher: typeof fetch = fetch.bind(globalThis)): Promise<GithubSignal> {
  if (!REPO_RX.test(repo)) throw new Error("Invalid repository name");
  const get = async (path: string) => {
    const res = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "compass" },
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${repo}${path || ""}`);
    return res.json() as Promise<any>;
  };
  const meta = await get("");
  const branch = String(meta.default_branch ?? "main");
  const [commits, pulls, runs] = await Promise.all([
    get(`/commits?per_page=5&sha=${encodeURIComponent(branch)}`).catch(() => []),
    get("/pulls?state=open&per_page=10&sort=updated&direction=desc").catch(() => []),
    get(`/actions/runs?per_page=1&branch=${encodeURIComponent(branch)}`).catch(() => ({ workflow_runs: [] })),
  ]);
  const run = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs[0] : undefined;
  return githubSignalSchema.parse({
    repo, defaultBranch: branch.slice(0, 200), pushedAt: typeof meta.pushed_at === "string" ? meta.pushed_at : null,
    commits: (Array.isArray(commits) ? commits : []).slice(0, 5).map((c: any) => ({
      sha: String(c.sha ?? "").slice(0, 12), at: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? "").slice(0, 40),
      subject: String(c.commit?.message ?? "").split("\n")[0].slice(0, 200), author: c.author?.login ? String(c.author.login).slice(0, 80) : null,
    })),
    openPrs: (Array.isArray(pulls) ? pulls : []).slice(0, 10).map((p: any) => ({ number: Number(p.number) || 0, title: String(p.title ?? "").slice(0, 200), updatedAt: String(p.updated_at ?? "").slice(0, 40), draft: p.draft === true })),
    ci: run ? { name: String(run.name ?? "CI").slice(0, 120), status: String(run.status ?? "").slice(0, 30), conclusion: run.conclusion ? String(run.conclusion).slice(0, 30) : null, at: String(run.updated_at ?? run.created_at ?? "").slice(0, 40), url: String(run.html_url ?? "").slice(0, 400) } : null,
  });
}
