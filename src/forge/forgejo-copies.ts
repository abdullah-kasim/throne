import type { ForgeDependencies } from "./forge-dependencies.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { forgejoCopyName, readRecordedCheckouts } from "./forgejo-checkouts.ts";
import { FORGEJO_PAGE_LIMIT } from "./forgejo-pull-requests.ts";
import { forgejoRemoteUrlOf, type ForgejoRepository } from "./forgejo-repository.ts";

interface ForgejoRepositoryRecord {
  readonly name: string;
  readonly owner: { readonly login: string };
}

export interface ForgejoCopy {
  readonly repository: ForgejoRepository;
  readonly checkout: string | undefined;
}

async function readAdminRepositories(api: ForgejoApi): Promise<ForgejoRepository[]> {
  const repositories: ForgejoRepository[] = [];
  for (let page = 1; ; page += 1) {
    const records = await api.readJson<ForgejoRepositoryRecord[]>(`user/repos?limit=${FORGEJO_PAGE_LIMIT}&page=${page}`);
    repositories.push(...records.map((record) => ({ owner: record.owner.login, name: record.name })));
    if (records.length < FORGEJO_PAGE_LIMIT) return repositories;
  }
}

async function usableCheckout(checkout: string | undefined, dependencies: ForgeDependencies): Promise<string | undefined> {
  if (checkout === undefined) return undefined;
  return (await forgejoRemoteUrlOf(checkout, dependencies)) === undefined ? undefined : checkout;
}

export async function forgejoCopiesWithCheckouts(api: ForgejoApi, dependencies: ForgeDependencies): Promise<ForgejoCopy[]> {
  const recorded = await readRecordedCheckouts();
  const repositories = await readAdminRepositories(api);
  return Promise.all(
    repositories.map(async (repository) => ({
      repository,
      checkout: await usableCheckout(recorded[forgejoCopyName(repository)], dependencies),
    })),
  );
}
